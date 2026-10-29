import { db } from './data';
import { config } from './config';
import { orderManager } from './orderManager';
import { printQueue } from './printQueue';
import { mergeTaxBreakdowns } from '../shared/orderTotals';
import type {
  OrderListFilter,
  OrderListPage,
  OrderDetailItem,
  OrderActivityLogEntry,
  EditOrderItemPayload,
  EditorApproval,
  SetOrderDiscountPayload,
  DiscountOptions,
  DiscountSettings,
  DiscountPreset,
  OrderDiscountInfo,
  FoodOrder,
} from '../shared/types';

/**
 * ordersListManager.ts
 * ---------------------------------------------------------------------------
 * Backs the Orders List page: paginated/filtered listing, per-item view/edit
 * with a full audit trail, order cancel (mandatory reason, manager/owner/
 * admin only) and complete, and manual reprint with session-only duplicate
 * detection.
 *
 * All reads/writes go through db.orderAdmin / db.orders (src/main/data),
 * which enforce who may do what. Mutations raise for an unauthorized caller
 * rather than silently no-op'ing, since that's a mutation, not a read.
 * ---------------------------------------------------------------------------
 */

export async function listOrders(filter: OrderListFilter): Promise<OrderListPage> {
  const outletId = requireOutletId();
  return db.orderAdmin.listOrders(outletId, filter);
}

/**
 * Orders List's invoice-grouped row detail — list_orders returns one row per
 * invoice_number rather than one row per order/round, so opening a row needs
 * every order sharing that invoice back (completed or cancelled included), not
 * just the table's current live batch.
 */
export async function getInvoiceOrderDetail(
  invoiceNumber: string,
): Promise<{ 
  orders: { id: string; orderNumber: number; status: string }[]; 
  items: OrderDetailItem[];
  discounts: OrderDiscountInfo[];
}> {
  const orders = await db.orderAdmin.listInvoiceOrders(invoiceNumber);
  if (orders.length === 0) return { orders, items: [], discounts: [] };

  const orderById = new Map(orders.map((o) => [o.id, o]));
  const records = await db.orderAdmin.listItemsForOrders(orders.map((o) => o.id));
  const items: OrderDetailItem[] = records.map((r) => ({
    ...r,
    orderNumber: orderById.get(r.orderId)?.orderNumber ?? 0,
  }));
  // Best effort: the details screen still opens if the discount lookup fails.
  const discounts = await db.orderAdmin.getOrderDiscounts(orders.map((o) => o.id)).catch(() => []);
  return { orders, items, discounts };
}

/** Invoice-grouped counterpart to getTableActivityLog — see getInvoiceOrderDetail above. */
export async function getInvoiceActivityLog(invoiceNumber: string): Promise<OrderActivityLogEntry[]> {
  const orders = await db.orderAdmin.listInvoiceOrders(invoiceNumber);
  const perOrder = await Promise.all(
    orders.map(async (o) =>
      (await db.orderAdmin.getOrderActivityLog(o.id)).map((r) => ({ ...r, orderNumber: o.orderNumber })),
    ),
  );
  return perOrder.flat();
}

/**
 * This machine's outlet (OUTLET_ID in .env.local), passed explicitly to the
 * edit/delete/cancel RPCs and list_orders(). The RPCs still re-check that the
 * signed-in user is a manager/owner/admin of that same outlet.
 */
function requireOutletId(): string {
  if (!config.outletId) {
    throw new Error('OUTLET_ID is not configured for this machine — set it in .env.local.');
  }
  return config.outletId;
}

const NOT_EDITABLE_MESSAGE =
  'Not authorized, item not found, or the order is not editable in its current status.';

export async function editOrderItem(payload: EditOrderItemPayload): Promise<void> {
  const outletId = requireOutletId();
  // Fast-fail with a clear message before attempting the write; the write
  // re-checks everything itself.
  if (!(await db.orderAdmin.isItemEditable(payload.orderItemId))) throw new Error(NOT_EDITABLE_MESSAGE);
  await db.orderAdmin.editItem({
    outletId,
    orderItemId: payload.orderItemId,
    quantity: payload.quantity,
    reason: payload.reason,
    approval: payload.approval,
  });
}

export async function deleteOrderItem(
  orderItemId: string,
  reason: string,
  approval: EditorApproval,
): Promise<void> {
  const outletId = requireOutletId();
  if (!(await db.orderAdmin.isItemEditable(orderItemId))) throw new Error(NOT_EDITABLE_MESSAGE);
  await db.orderAdmin.deleteItem({ outletId, orderItemId, reason, approval });
}

export async function cancelOrderWithReason(
  orderId: string,
  reason: string,
  approval: EditorApproval,
): Promise<void> {
  await db.orderAdmin.cancelOrder({ outletId: requireOutletId(), orderId, reason, approval });
}

export function getDiscountSettings(): Promise<DiscountSettings> {
  return db.orderAdmin.getDiscountSettings();
}

export async function saveDiscountPresets(presets: DiscountPreset[]): Promise<void> {
  if (!Array.isArray(presets) || presets.length < 1 || presets.length > 10) {
    throw new Error('Keep between 1 and 10 discount percentages.');
  }
  const seen = new Set<number>();
  for (const p of presets) {
    const v = Number(p.percent);
    if (!Number.isFinite(v) || v <= 0 || v >= 100) throw new Error('A discount must be above 0 and below 100.');
    if (Math.round(v * 100) !== v * 100 && Math.abs(Math.round(v * 100) - v * 100) > 1e-9) {
      throw new Error('A discount can have at most two decimals.');
    }
    if (seen.has(v)) throw new Error(`${v}% is listed twice.`);
    seen.add(v);
  }
  if (!presets.some((p) => p.isActive)) throw new Error('At least one discount must stay active.');
  await db.orderAdmin.saveDiscountPresets(presets.map((p) => ({ percent: Number(p.percent), isActive: p.isActive === true })));
}

export function getDiscountOptions(): Promise<DiscountOptions> {
  return db.orderAdmin.getDiscountOptions();
}

/** Discount or complimentary on one order or all rounds of a table. The database checks the permission and the rules. */
export async function setOrderDiscount(p: SetOrderDiscountPayload): Promise<void> {
  const ids = Array.isArray(p.orderIds) ? [...new Set(p.orderIds.filter((x) => typeof x === 'string' && x))] : [];
  if (ids.length === 0 || ids.length > 50) throw new Error('Choose an order.');
  if (!['percent', 'amount', 'complimentary', 'none'].includes(p.mode)) throw new Error('Choose a discount type.');
  let value: number | null = null;
  if (p.mode === 'percent' || p.mode === 'amount') {
    value = Number(p.value);
    if (!Number.isFinite(value) || value <= 0) throw new Error('Enter a discount greater than 0.');
    if (p.mode === 'percent' && value >= 100) throw new Error('Choose one of the allowed discounts.');
    if (p.mode === 'amount' && ids.length > 1) throw new Error('A fixed amount can only be given on one order. Use a percentage for several orders.');
    value = Math.round(value * 100) / 100;
  }
  const reason = p.reason?.trim() ?? '';
  if (p.mode !== 'none' && (reason.length < 1 || reason.length > 200)) throw new Error('Enter a reason (up to 200 characters).');
  await db.orderAdmin.setOrderDiscount({ orderIds: ids, mode: p.mode, value, reason: p.mode === 'none' ? null : reason });
}

/** "Cancel all" for a dine-in invoice: every not-yet-cancelled round, one editor approval. */
export async function cancelInvoiceWithReason(
  invoiceNumber: string,
  reason: string,
  approval: EditorApproval,
): Promise<void> {
  await db.orderAdmin.cancelInvoice({ outletId: requireOutletId(), invoiceNumber, reason, approval });
}

export function completeInvoice(invoiceNumber: string): Promise<number> {
  if (!invoiceNumber?.trim()) throw new Error('An invoice number is required.');
  return db.orderAdmin.completeInvoice(invoiceNumber.trim());
}

export function completeOrder(orderId: string): Promise<void> {
  return db.orderAdmin.completeOrder(orderId);
}

/**
 * Reprint the bill for an order from the Orders List page. If the order is
 * already completed, this is by definition a reprint of an already-final
 * bill, so it prints with a "DUPLICATE BILL" banner. An active (open) order
 * prints normally — no state to track, no session counting.
 *
 * Routed through the SAME shared printQueue as the HTTP /api/print-order
 * endpoint (see printQueue.ts) — a manual reprint from this page and an
 * incoming Android order must never write to the printer at the same time,
 * regardless of which one arrived first.
 */
export async function reprintOrder(invoiceNumber: string): Promise<void> {
  await printQueue.enqueue(async () => {
    //const order = await db.orders.fetchOrderById(orderId, config.outletId);
    orderManager.handleSettleByNumbers(invoiceNumber, config.outletId);
  });
}

