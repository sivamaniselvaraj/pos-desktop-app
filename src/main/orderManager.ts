import { EventEmitter } from 'events';
import {
  fetchOrderById,
  fetchUnprintedItems,
  markItemsKotPrinted,
  fetchAggregatedItems,
  getOrderStatus,
  closeOrderAndFreeTable,
  markOrdersCompleted,
  fetchOrdersByNumbers,
  fetchAggregatedItemsForOrders,
} from './supabaseClient';
import { printOrderEscpos, printKot } from './printerManager';
import { getPrinterFor } from './settingsManager';
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
    const targetRole = order.orderType === 'dine_in' ? 'waiter' : 'kitchen';
    const targetPrinter = getPrinterFor(targetRole);
        if (!targetPrinter) {
          const roleLabel = targetRole === 'waiter' ? 'Waiter' : 'Kitchen';
          const msg = `No ${roleLabel.toLowerCase()} printer configured. Add a "${roleLabel}" printer in Settings to print KOTs.`;
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
      await printKot(kotOrder, targetPrinter);
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
     * Settle, unified: handles BOTH dine-in (grouped) and takeaway (standalone)
     * from one method, keyed on order NUMBERS rather than a single orderId —
     * this is the simplification discussed with the user: knowing up front
     * (via the request's orderType, resolved in httpServer.ts) whether this is
     * a table's full batch of order numbers or one takeaway order's number
     * means this method needs exactly ONE query to fetch everything it needs
     * (fetchOrdersByNumbers), instead of first resolving a single "anchor"
     * order id and then re-discovering the same batch a second time.
     *
     * - Dine-in: httpServer passes every order number in the table's current
     *   batch (fetchTableOrderNumbers) — `orderNumbers.length > 1` whenever
     *   there's more than one still-open round, and items/totals get merged
     *   into one printed bill exactly as before.
     * - Takeaway: httpServer passes a single-element array — no table_id
     *   involved, so this naturally settles standalone.
     *
     * Idempotent: if every matched order is already 'completed', nothing
     * prints and nothing is re-cached (second tap on an already-settled
     * table/order is a no-op). Only after a successful print are the orders
     * marked completed (markOrdersCompleted) — the table itself is NOT freed
     * here; that only happens once payment is recorded via the Table
     * Dashboard's Save button (save_order_payment RPC).
     */
    async handleSettleByNumbers(orderNumbers: number[], outletId: string): Promise<PrintOrderResponse> {
      if (orderNumbers.length === 0) {
        return {
          success: false,
          orderId: '',
          message: 'No orders to settle',
          printStatus: 'failed',
          error: 'NOT_FOUND',
        };
      }
  
      const orders = await fetchOrdersByNumbers(orderNumbers, outletId);
      if (orders.length === 0) {
        return {
          success: false,
          orderId: '',
          message: `No matching order(s) found for #${orderNumbers.join(', ')}`,
          printStatus: 'failed',
          error: 'NOT_FOUND',
        };
      }
  
      const anchor = orders[0];
  
      // Idempotency guard: second settle on an already-completed batch prints
      // nothing. ('completed' is the real closed-order status — see
      // get_sales_report_uid in db/functions.sql for why 'settled' was wrong.)
      if (orders.every((o) => o.status === 'completed')) {
        const existing = this.orders.get(anchor.id);
        return {
          success: true,
          orderId: anchor.id,
          message: 'Order already settled',
          printStatus: existing?.printStatus ?? 'printed',
        };
      }
  
      const isGrouped = orders.length > 1;
      const orderIds = orders.map((o) => o.id);
      const items = isGrouped
        ? await fetchAggregatedItemsForOrders(orderIds)
        : await fetchAggregatedItems(anchor.id);
  
      // For a grouped table bill, sum every order's totals rather than using
      // just the anchor's own subtotal/tax/total.
      const summed = orders.reduce(
        (acc, o) => ({
          subtotal: acc.subtotal + o.subtotal,
          tax: acc.tax + o.tax,
          total: acc.total + o.total,
          discount: acc.discount + (o.discount ?? 0),
          containerCharge: acc.containerCharge + (o.containerCharge ?? 0),
        }),
        { subtotal: 0, tax: 0, total: 0, discount: 0, containerCharge: 0 },
      );
  
      const billOrder: OrderWithStatus = {
        ...anchor,
        items,
        subtotal: summed.subtotal,
        tax: summed.tax,
        total: summed.total,
        discount: summed.discount || undefined,
        containerCharge: summed.containerCharge || undefined,
        orderNumbers: isGrouped
          ? orders.map((o) => o.orderNumber).sort((a, b) => a - b)
          : undefined,
        printStatus: 'printing',
        retryCount: 0,
      };
  
      try {
        await printOrderEscpos(billOrder, config.cashierPrinter);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown print error';
        this.cacheForDisplay({ ...billOrder, printStatus: 'failed', errorMessage: message });
        return { success: false, orderId: anchor.id, message, printStatus: 'failed', error: 'PRINT_FAILED' };
      }
  
      // Mark every order in the batch completed only after the bill prints.
      // The table is freed later, once payment is recorded (save_order_payment RPC).
      await markOrdersCompleted(orderIds);
  
      // Cache every settled order for display directly from what was already
      // fetched — no extra round trip needed, we already know the resulting
      // state (status flips to 'completed', print just succeeded).
      const printedAt = new Date().toISOString();
      for (const o of orders) {
        this.cacheForDisplay({ ...o, status: 'completed', printStatus: 'printed', printedAt, retryCount: 0 });
      }
  
      const message = isGrouped
        ? `Bill printed and ${orders.length} orders settled for the table`
        : 'Bill printed and order settled';
      return { success: true, orderId: anchor.id, message, printStatus: 'printed' };
    }

  /**
   * Settle: idempotent. If already settled => no-op (second tap prints
   * nothing). Otherwise print the full bill aggregated by dish, then close the
   * order and free the table.
   */
  private async handleSettle(orderId: string, order: FoodOrder): Promise<PrintOrderResponse> {
    const cashierPrinter = config.cashierPrinter; //'RP3160 GOLD(U) 1'; // getPrinterFor('waiter');
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
        const printerName = config.cashierPrinter;
        await printOrderEscpos(order, printerName); //ng thermal printer
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
    this.cacheForDisplay(order);
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
