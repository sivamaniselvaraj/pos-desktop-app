import { db } from './data';
import { config } from './config';
import { printOrderEscpos } from './printerManager';
import { printQueue } from './printQueue';
import type {
  OrderListFilter,
  OrderListPage,
  OrderDetailItem,
  OrderActivityLogEntry,
  EditOrderItemPayload,
  EditorApproval,
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
}> {
  const orders = await db.orderAdmin.listInvoiceOrders(invoiceNumber);
  if (orders.length === 0) return { orders, items: [] };

  const orderById = new Map(orders.map((o) => [o.id, o]));
  const records = await db.orderAdmin.listItemsForOrders(orders.map((o) => o.id));
  const items: OrderDetailItem[] = records.map((r) => ({
    ...r,
    orderNumber: orderById.get(r.orderId)?.orderNumber ?? 0,
      }));
  return { orders, items };
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

/** "Cancel all" for a dine-in invoice: every not-yet-cancelled round, one editor approval. */
export async function cancelInvoiceWithReason(
  invoiceNumber: string,
  reason: string,
  approval: EditorApproval,
): Promise<void> {
  await db.orderAdmin.cancelInvoice({ outletId: requireOutletId(), invoiceNumber, reason, approval });
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
export async function reprintOrder(orderId: string): Promise<void> {
  await printQueue.enqueue(async () => {
    const order = await db.orders.fetchOrderById(orderId);
    if (!order) throw new Error(`Order ${orderId} not found.`);

    // Same aggregation settle uses: non-deleted items only, merged by dish so
    // an edited quantity or a deleted line reflects correctly on the reprint.
    const items = await db.orders.fetchAggregatedItems(orderId);
    const billOrder = { ...order, items };

    const isDuplicate = order.status === 'completed';

    await printOrderEscpos(billOrder, config.cashierPrinter, isDuplicate);
  });
}

  /**
   * Table Dashboard's "duplicate bill" reprint for a settled-awaiting-payment
   * table card. Unlike reprintOrder above (single order), this reprints the
   * WHOLE table batch merged together — the same grouping handleSettle used
   * when it originally printed the bill — so a reprint after multiple rounds
   * were settled together still shows every order# and every item, not just
   * whichever single order id the card happened to carry.
   */
  export async function reprintTableBill(tableId: string): Promise<void> {
    await printQueue.enqueue(async () => {
       
      const group = await db.orders.fetchTableBatchOrders(tableId);
       if (!group) throw new Error(`Orders found for table ${tableId}`);

      const groupIds = group.orderIds.length > 0 ? group.orderIds : [];

      const order = await db.orders.fetchOrderById(groupIds[0]);
      if (!order) throw new Error(`Orders found for table ${tableId}`);
      
      const isGrouped = groupIds.length > 1;

      if (!isGrouped) {
            const items = await db.orders.fetchAggregatedItems(tableId);
            await printOrderEscpos({ ...order, items }, config.cashierPrinter, true);
            return;
          }
  
      const items = await db.orders.fetchAggregatedItemsForOrders(groupIds);
      const groupOrders = (await Promise.all(groupIds.map((id) => db.orders.fetchOrderById(id)))).filter(
        (o): o is FoodOrder => o != null,
      );
      const summed = groupOrders.reduce(
        (acc, o) => ({
          subtotal: acc.subtotal + o.subtotal,
          tax: acc.tax + o.tax,
          total: acc.total + o.total,
          discount: acc.discount + (o.discount ?? 0),
          containerCharge: acc.containerCharge + (o.containerCharge ?? 0),
        }),
        { subtotal: 0, tax: 0, total: 0, discount: 0, containerCharge: 0 },
      );
      const billOrder: FoodOrder = {
        ...order,
        items,
        subtotal: summed.subtotal,
        tax: summed.tax,
        total: summed.total,
        discount: summed.discount || undefined,
        containerCharge: summed.containerCharge || undefined,
        orderNumbers: group.orderNumbers,
      };
      await printOrderEscpos(billOrder, config.cashierPrinter, true);
    });
}
