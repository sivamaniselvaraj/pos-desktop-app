import { EventEmitter } from 'events';
import { fetchOrderById,  fetchUnprintedItems,
  markItemsKotPrinted,
  fetchAggregatedItems,
  getOrderStatus,
  closeOrderAndFreeTable,} from './supabaseClient';
import { printOrderEscpos, printKot } from './printerManager';
import { getPrinterFor } from './settingsManager';
import { config } from './config';
import type { OrderWithStatus, PrintOrderResponse, PrintStatus, PrintType } from '../shared/types';

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

  private setStatus(orderId: string, status: PrintStatus, errorMessage?: string): void {
    const order = this.orders.get(orderId);
    if (!order) return;
    order.printStatus = status;
    order.errorMessage = errorMessage;
    if (status === 'printed') order.printedAt = new Date().toISOString();
    this.emit('status-changed', { ...order });
  }

  // Called by the HTTP server when Android posts an order ID.
  async handleIncoming(orderId: string, type: PrintType = 'bill'): Promise<PrintOrderResponse> {
    let order = this.orders.get(orderId);

    if (!order) {
      const fetched = await fetchOrderById(orderId);
      if (!fetched) {
        return {
          success: false,
          orderId,
          message: `Order ${orderId} not found in database`,
          printStatus: 'failed',
          error: 'NOT_FOUND',
        };
      }
      order = { ...fetched, printStatus: 'pending', retryCount: 0 };
      this.orders.set(orderId, order);
      this.emit('order-received', { ...order });
    }

    if (type === 'kot') return this.handleKot(orderId);
    if (type === 'settle') return this.handleSettle(orderId);

    const ok = await this.attemptPrint(orderId);
    const current = this.orders.get(orderId)!;
    return {
      success: ok,
      orderId,
      message: ok ? 'Order printed' : 'Print failed',
      printStatus: current.printStatus,
      error: ok ? undefined : current.errorMessage,
    };
  }

  /**
     * KOT on confirm: print only the delta (items not yet sent to the kitchen),
     * then stamp them printed. Stamping happens AFTER a successful print so a
     * print failure keeps the delta for a retry. No unprinted items => no-op.
     */
    private async handleKot(orderId: string): Promise<PrintOrderResponse> {
      const base = this.orders.get(orderId);
      if (!base) {
        return { success: false, orderId, message: 'Order not in queue', printStatus: 'failed', error: 'NOT_FOUND' };
      }
  
      const waiterPrinter = 'RP3160 GOLD(U) 1';// getPrinterFor('waiter');
      if (!waiterPrinter) {
        const msg = 'No waiter printer configured. Add a "Waiter" printer in Settings to print KOTs.';
        this.setStatus(orderId, 'failed', msg);
        return { success: false, orderId, message: msg, printStatus: 'failed', error: 'NO_PRINTER' };
      }
  
      const deltaItems = await fetchUnprintedItems(orderId);
      if (deltaItems.length === 0) {
        // Nothing new since the last KOT — idempotent no-op.
        return {
          success: true,
          orderId,
          message: 'No new items to print',
          printStatus: base.printStatus,
        };
      }
  
      // Print a KOT containing only the delta items.
      const kotOrder = { ...base, items: deltaItems };
      this.setStatus(orderId, 'printing');
      try {
        await printKot(kotOrder, waiterPrinter);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown print error';
        this.setStatus(orderId, 'failed', message);
        return { success: false, orderId, message, printStatus: 'failed', error: 'PRINT_FAILED' };
      }
  
      // Stamp only after a successful print.
      await markItemsKotPrinted(deltaItems.map((i) => i.id));
      this.setStatus(orderId, 'printed');
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
    private async handleSettle(orderId: string): Promise<PrintOrderResponse> {
      const base = this.orders.get(orderId);
      if (!base) {
        return { success: false, orderId, message: 'Order not in queue', printStatus: 'failed', error: 'NOT_FOUND' };
      }
  
      // Idempotency guard: second tap on an already-settled order prints nothing.
      const status = await getOrderStatus(orderId);
      if (status === 'settled') {
        return { success: true, orderId, message: 'Order already settled', printStatus: base.printStatus };
      }
  
      const items = await fetchAggregatedItems(orderId);
      const billOrder = { ...base, items };
      this.setStatus(orderId, 'printing');
      try {
        await printOrderEscpos(billOrder, "cashier");
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown print error';
        this.setStatus(orderId, 'failed', message);
        return { success: false, orderId, message, printStatus: 'failed', error: 'PRINT_FAILED' };
      }
  
      // Close the order and free the table only after the bill prints.
      await closeOrderAndFreeTable(orderId);
      this.setStatus(orderId, 'printed');
      return { success: true, orderId, message: 'Bill printed and order settled', printStatus: 'printed' };
    }

  // Attempt a single print, with auto-retry/backoff if enabled.
  private async attemptPrint(orderId: string): Promise<boolean> {
    const order = this.orders.get(orderId);
    if (!order) return false;

    const maxAttempts = config.autoRetry ? config.retryCount : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));

      order.retryCount = attempt;
      this.setStatus(orderId, 'printing');
      try {
        // await printOrder(order); // Plain-text fallback
        await printOrderEscpos(order, 'RP3160 GOLD(U) 1');  //ng thermal printer
        //await printOrderPosPrinter(); //electron printer
        this.setStatus(orderId, 'printed');
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown print error';
        this.setStatus(orderId, 'failed', message);
      }
    }
    return false;
  }

  // Manual retry triggered from the UI.
  async retry(orderId: string): Promise<PrintOrderResponse> {
    const order = this.orders.get(orderId);
    if (!order) {
      return { success: false, orderId, message: 'Order not in queue', printStatus: 'failed', error: 'NOT_FOUND' };
    }
    const ok = await this.attemptPrint(orderId);
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
