import { EventEmitter } from 'events';
import {
  fetchOrderById,
  fetchUnprintedItems,
  markItemsKotPrinted,
  fetchAggregatedItems,
  getOrderStatus,
  closeOrderAndFreeTable,
} from './supabaseClient';
import { printOrderEscpos, printKot } from './printerManager';
import { config } from './config';
import type {
  FoodOrder,
  OrderWithStatus,
  PrintOrderResponse,
  PrintStatus,
  PrintType,
} from '../shared/types';

// Backoff delays per attempt (ms): attempt 1 immediate, then 5s, then 10s.
const RETRY_DELAYS = [0, 5000, 10000];

class OrderManager extends EventEmitter {
  private orders = new Map<string, OrderWithStatus>();

  getAll(): OrderWithStatus[] {
    return Array.from(this.orders.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  get(orderId: string): OrderWithStatus | undefined {
    return this.orders.get(orderId);
  }

  /** Write an order into the display cache and notify the UI. */
  private cacheForDisplay(order: OrderWithStatus): void {
    const existed = this.orders.has(order.id);
    this.orders.set(order.id, order);
    this.emit(existed ? 'status-changed' : 'order-received', { ...order });
  }

  // Called by the HTTP server when Android posts an order ID.
  async handleIncoming(orderId: string, type: PrintType = 'bill'): Promise<PrintOrderResponse> {
    let order = await fetchOrderById(orderId);

    if (!order) {
      return {
        success: false,
        orderId,
        message: `Order ${orderId} not found in database`,
        printStatus: 'failed',
        error: 'NOT_FOUND',
      };
    }

    if (type === 'kot') return this.handleKot(orderId, order);
    if (type === 'settle') return this.handleSettle(orderId, order);

    return {
      success: false,
      orderId,
      message: `Billing Type not found`,
      printStatus: 'failed',
      error: 'NOT_FOUND',
    };
  }

  /**
   * KOT on confirm: print only the delta (items not yet sent to the kitchen),
   * then stamp them printed. Stamping happens AFTER a successful print so a
   * print failure keeps the delta for a retry. No unprinted items => no-op.
   */
  private async handleKot(orderId: string, order: FoodOrder): Promise<PrintOrderResponse> {
    const waiterPrinter = 'RP3160 GOLD(U) 1'; // getPrinterFor('waiter');
    if (!waiterPrinter) {
      const msg = 'No waiter printer configured. Add a "Waiter" printer in Settings to print KOTs.';
      this.cacheForDisplay({ ...order, printStatus: 'failed', errorMessage: msg, retryCount: 0 });
      return { success: false, orderId, message: msg, printStatus: 'failed', error: 'NO_PRINTER' };
    }

    const deltaItems = await fetchUnprintedItems(orderId);
    if (deltaItems.length === 0) {
      // Nothing new since the last KOT — idempotent no-op, nothing to cache.
      const existing = this.orders.get(orderId);
      return {
        success: true,
        orderId,
        message: 'No new items to print',
        printStatus: existing?.printStatus ?? 'printed',
      };
    }

    // Print a KOT containing only the delta items.
    const kotOrder: OrderWithStatus = {
      ...order,
      items: deltaItems,
      printStatus: 'printing',
      retryCount: 0,
    };

    try {
      await printKot(kotOrder, waiterPrinter);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown print error';
      this.cacheForDisplay({ ...kotOrder, printStatus: 'failed', errorMessage: message });
      return { success: false, orderId, message, printStatus: 'failed', error: 'PRINT_FAILED' };
    }

    // Stamp only after a successful print.
    await markItemsKotPrinted(orderId);
    // Re-fetch so the UI shows the full order (all items, updated
    // kot_printed flags) rather than just the delta that was printed.
    const postStamp = (await fetchOrderById(orderId)) ?? order;
    this.cacheForDisplay({
      ...postStamp,
      printStatus: 'printed',
      printedAt: new Date().toISOString(),
      retryCount: 0,
    });
    return {
      success: true,
      orderId,
      message: `KOT printed (${deltaItems.length} new item${deltaItems.length === 1 ? '' : 's'})`,
      printStatus: 'printed',
    };
  }

  /**
   * Settle: idempotent. If already settled => no-op (second tap prints
   * nothing). Otherwise print the full bill aggregated by dish, then close the
   * order and free the table.
   */
  private async handleSettle(orderId: string, order: FoodOrder): Promise<PrintOrderResponse> {
    const cashierPrinter = 'RP3160 GOLD(U) 1'; // getPrinterFor('waiter');
    if (!cashierPrinter) {
      const msg =
        'No cashier printer configured. Add a "Cashier" printer in Settings to print Bill.';
      this.cacheForDisplay({ ...order, printStatus: 'failed', errorMessage: msg, retryCount: 0 });
      return { success: false, orderId, message: msg, printStatus: 'failed', error: 'NO_PRINTER' };
    }

    // Idempotency guard: second tap on an already-settled order prints nothing.
    const status = await getOrderStatus(orderId);
    if (status === 'settled') {
      const existing = this.orders.get(orderId);
      return {
        success: true,
        orderId,
        message: 'Order already settled',
        printStatus: existing?.printStatus ?? 'printed',
      };
    }

    const items = await fetchAggregatedItems(orderId);
    const billOrder: OrderWithStatus = {
      ...order,
      items,
      printStatus: 'printing',
      retryCount: 0,
    };
    try {
      await printOrderEscpos(billOrder, cashierPrinter);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown print error';
      this.cacheForDisplay({ ...billOrder, printStatus: 'failed', errorMessage: message });
      return { success: false, orderId, message, printStatus: 'failed', error: 'PRINT_FAILED' };
    }

    // Close the order and free the table only after the bill prints.
    await closeOrderAndFreeTable(orderId);
    const postClose = (await fetchOrderById(orderId)) ?? billOrder;
    this.cacheForDisplay({
      ...postClose,
      printStatus: 'printed',
      printedAt: new Date().toISOString(),
      retryCount: 0,
    });
    return {
      success: true,
      orderId,
      message: 'Bill printed and order settled',
      printStatus: 'printed',
    };
  }

  // Attempt a single print, with auto-retry/backoff if enabled.
  private async attemptPrint(order: OrderWithStatus): Promise<boolean> {
    if (!order) return false;

    const maxAttempts = config.autoRetry ? config.retryCount : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));

      order.retryCount = attempt;
      order.printStatus = 'printing';
      try {
        // await printOrder(order); // Plain-text fallback
        await printOrderEscpos(order, 'RP3160 GOLD(U) 1'); //ng thermal printer
        order.printStatus = 'printed';
        order.printedAt = new Date().toISOString();
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown print error';
        order.printStatus = 'failed';
      }
    }
    return false;
  }

  // Manual retry triggered from the UI.
  async retry(orderId: string): Promise<PrintOrderResponse> {
    const order = this.orders.get(orderId);
    if (!order) {
      return {
        success: false,
        orderId,
        message: 'Order not in queue',
        printStatus: 'failed',
        error: 'NOT_FOUND',
      };
    }
    const ok = await this.attemptPrint(order);
    const current = this.orders.get(orderId)!;
    return {
      success: ok,
      orderId,
      message: ok ? 'Order printed' : 'Print failed',
      printStatus: current.printStatus,
      error: ok ? undefined : current.errorMessage,
    };
  }

  cancel(orderId: string): void {
    const order = this.orders.get(orderId);
    if (order && order.printStatus !== 'printing') {
      this.orders.delete(orderId);
      this.emit('status-changed', { ...order, printStatus: 'failed', errorMessage: 'Cancelled' });
    }
  }

  clearPrinted(): void {
    for (const [id, order] of this.orders) {
      if (order.printStatus === 'printed') this.orders.delete(id);
    }
  }
}

export const orderManager = new OrderManager();
