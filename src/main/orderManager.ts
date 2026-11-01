import { EventEmitter } from 'events';
import { db } from './data';
import { printOrderEscpos, printKot } from './printerManager';
import { getPrinterFor } from './settingsManager';
import { config } from './config';
import { mergeTaxBreakdowns } from '../shared/orderTotals';
import { loadPendingPrintState, type PersistentIdSet } from './pendingPrintState';
import {
  DINE_IN_ORDER_TYPE,
  PICK_UP_ORDER_TYPE,
  PRINT_KOT,
  PRINT_KOT_ONLY,
  type FoodOrder,
  type OrderWithStatus,
  type PrintOrderResponse,
  type PrintType,
} from '../shared/types';

// Backoff delays per attempt (ms): attempt 1 immediate, then 5s, then 10s.
const RETRY_DELAYS = [0, 5000, 10000];

// A repeated plain-bill request for the same order inside this window gets the
// earlier result instead of printing again (Android retry after a timeout, a
// double tap). Orders List "Reprint" does not go through handleBill.
// Every bill print sets orders.is_printed (first time only, keeping printed_at);
// a bill for an order already printed carries the DUPLICATE BILL heading.
const BILL_DEDUPE_MS = 30_000;

/** Retry a short database write a few times before giving up. */
async function withDbRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1) ** 2));
    }
  }
  throw last;
}

/**
 * Record that a bill printed for these orders (is_printed, printed_at). The
 * bill is already on paper, so a failure is logged and never fails the print;
 * at worst the next print of that order is not headed DUPLICATE BILL.
 */
export async function recordBillPrinted(orderIds: string[]): Promise<void> {
  try {
    await withDbRetry(() => db.orders.markOrdersBillPrinted(orderIds));
  } catch (err) {
    console.error('[orderManager] Bill printed but is_printed could not be saved:', err instanceof Error ? err.message : err);
  }
}

class OrderManager extends EventEmitter {
  // Display cache ONLY. This is populated after a print attempt concludes
  // (success or failure) so the operator console has something to show and
  // failed prints can be retried from the UI. It is never read as a source
  // of order data during a print — every print attempt fetches fresh from
  // the DB first (see handleIncoming). This avoids the earlier bug where a
  // pre-populated cache went stale relative to the database.
  private orders = new Map<string, OrderWithStatus>();

    // Printed on paper but the database update failed. Remembered so the next
    // attempt only retries the update and never prints the same thing again.
    // Saved to pending-print-state.json (see pendingPrintState.ts) so a restart
    // between the print and the update does not print the ticket or bill again.
    // Loaded on first use, after Electron has set up the app paths.
    private pending: { kotStamps: PersistentIdSet; settles: PersistentIdSet } | null = null;
    private get pendingSettles(): PersistentIdSet {
      return (this.pending ??= loadPendingPrintState()).settles; // orders ids
    }

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

  // Called by the HTTP server when Android posts an order ID / print event.
  // Always fetches fresh from the DB — the cache is not consulted here.
  // 'settle' can also arrive via handleSettleByNumbers directly (see below)
  // when the request already carries a table/order NUMBER rather than a
  // single orderId — that's the preferred path now (httpServer.ts resolves
  // it there, using the request's orderType to know which). This orderId
  // entrypoint stays for KOT/plain-bill (always orderId-based) and as a
  // backward-compatible shim for a legacy orderId-only settle request.
  async handleIncoming(orderId: string, type: PrintType = 'bill'): Promise<PrintOrderResponse> {
    let order = await db.orders.fetchOrderById(orderId, config.outletId);
    if (!order) {
      return {
        success: false,
        orderId,
        message: `Order ${orderId} not found in database`,
        printStatus: 'failed',
        error: 'NOT_FOUND',
      };
    }

    if(order.orderType === PICK_UP_ORDER_TYPE && type != PRINT_KOT_ONLY) {
      this.handleSettleByNumbers(order.invoiceNumber!, config.outletId);
    }
    if (type === PRINT_KOT || type === PRINT_KOT_ONLY) {
      return this.handleKot(orderId, order);
    }
   
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
    const targetRole = order.orderType === DINE_IN_ORDER_TYPE ? 'waiter' : 'kitchen';
    const targetPrinter = getPrinterFor(targetRole);
        if (!targetPrinter) {
          const roleLabel = targetRole === 'waiter' ? 'Waiter' : 'Kitchen';
          const msg = `No ${roleLabel.toLowerCase()} printer configured. Add a "${roleLabel}" printer in Settings to print KOTs.`;
          this.cacheForDisplay({ ...order, printStatus: 'failed', errorMessage: msg, retryCount: 0 });
          return { success: false, orderId, message: msg, printStatus: 'failed', error: 'NO_PRINTER' };
        }

    const deltaItems = await db.orders.fetchUnprintedItems(orderId);
    const orderCount = await db.orders.checkForRunningOrder(order.invoiceNumber!)
    if(orderCount > 1){
      order.isRunningOrder = true;
    }
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
    try {
      await withDbRetry(() => db.orders.markItemsKotPrinted(deltaItems.map((i) => i.id)));
    } catch (err) {
      //deltaItems.forEach((id) => this.pendingKotStamps.add(id));
      console.error('[orderManager] KOT printed but could not be stamped; will retry the stamp only:', err instanceof Error ? err.message : err);
    }

    // Re-fetch so the UI shows the full order (all items, updated
    // kot_printed flags) rather than just the delta that was printed.
    const postStamp = (await db.orders.fetchOrderById(orderId, config.outletId).catch(() => null)) ?? order;
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
    async handleSettleByNumbers(invoiceNumber: string, outletId: string): Promise<PrintOrderResponse> {
      if (invoiceNumber.trim() === '') {
        return {
          success: false,
          orderId: '',
          message: 'No orders to settle',
          printStatus: 'failed',
          error: 'NOT_FOUND',
        };
      }
  
    const orders = await db.orders.fetchOrdersByInvoiceNumbers(invoiceNumber, outletId);
      if (orders.length === 0) {
        return {
          success: false,
          orderId: '',
          message: `No matching order(s) found for #${invoiceNumber.slice(-5)}`,
          printStatus: 'failed',
          error: 'NOT_FOUND',
        };
      }
      const anchor = orders[0];
      // The bill is already on paper but marking the orders completed failed
      // earlier: only retry that update, never print the bill again.
      const open = orders.filter((o) => o.status !== 'completed');
      if (open.length > 0 && open.every((o) => this.pendingSettles.has(o.id))) {
        try {
          await withDbRetry(() => db.orders.markOrdersCompleted(open.map((o) => o.id)));
          open.forEach((o) => this.pendingSettles.delete(o.id));
          return { success: true, orderId: anchor.id, message: 'Order settled', printStatus: 'printed' };
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          return {
            success: false,
            orderId: anchor.id,
            message: `Bill was already printed, but the order could not be marked settled yet (${message}). Not printing again.`,
            printStatus: 'printed',
            error: 'SETTLE_PENDING',
          };
        }
      }
  
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
      ? await db.orders.fetchAggregatedItemsForOrders(orderIds)
      : await db.orders.fetchAggregatedItems(anchor.id);
  
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
        taxBreakdown: mergeTaxBreakdowns(orders.map((o) => o.taxBreakdown)),
        total: summed.total,
        discount: summed.discount || undefined,
        isComplimentary: orders.every((o) => o.isComplimentary === true),
        containerCharge: summed.containerCharge || undefined,
        orderNumbers: isGrouped
          ? orders.map((o) => o.orderNumber).sort((a, b) => a - b)
          : [Number(anchor.orderNumber)],
        printStatus: 'printing',
        retryCount: 0,
      };
    // A bill already printed for every order in it (e.g. the phone printed a
    // plain bill before settling) is a duplicate. A table bill with a new
    // round that never printed is a new bill.
    const isDuplicate = orders.every((o) => o.isPrinted === true);
    try {
      await printOrderEscpos(billOrder, config.cashierPrinter, isDuplicate);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown print error';
      this.cacheForDisplay({ ...billOrder, printStatus: 'failed', errorMessage: message });
      return { success: false, orderId: anchor.id, message, printStatus: 'failed', error: 'PRINT_FAILED' };
    }
    await recordBillPrinted(orderIds);
      // Mark every order in the batch completed only after the bill prints.
      // The table is freed later, once payment is recorded (save_order_payment RPC).
    let settlePending = false;
    try {
      await withDbRetry(() => db.orders.markOrdersCompleted(orderIds));
    } catch (err) {
      settlePending = true;
      orderIds.forEach((id) => this.pendingSettles.add(id));
      console.error('[orderManager] Bill printed but orders could not be marked completed; will retry that only:', err instanceof Error ? err.message : err);
    }

    // Cache every settled order for display directly from what was already
    // fetched — no extra round trip needed, we already know the resulting
    // state (status flips to 'completed', print just succeeded).
    const printedAt = new Date().toISOString();
    for (const o of orders) {
      this.cacheForDisplay({
        ...o,
        status: 'completed',
        isPrinted: true,
        printStatus: 'printed',
        printedAt,
        retryCount: 0,
      });
    }
    const message = isGrouped
      ? `Bill printed and ${orders.length} orders settled for the table`
      : 'Bill printed and order settled';
    return {
      success: true,
      orderId: anchor.id,
      message,
      printStatus: 'printed',
    };
  }

  // Attempt a single print, with auto-retry/backoff if enabled. (bill path)
  // Mutates `order` in place; caller decides when/whether to cache it.
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
        if (!order.isPrinted) {
          order.isPrinted = true;
          await recordBillPrinted([order.id]);
        }
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown print error';
        order.errorMessage = message;
        order.printStatus = 'failed';
      }
    }
    return false;
  }

  // Manual retry triggered from the UI. Operates on the cached (already
  // printed-or-failed) entry — retries exactly what previously failed.
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
    this.cacheForDisplay(order);
    return {
      success: ok,
      orderId,
      message: ok ? 'Order printed' : 'Print failed',
      printStatus: order.printStatus,
      error: ok ? undefined : order.errorMessage,
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
