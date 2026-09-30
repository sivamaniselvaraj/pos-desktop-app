import { getAuthedClient } from './supabaseAuthClient';
import { 
  fetchOrderById, 
  fetchAggregatedItems, 
  fetchTableBatchOrders,
  fetchAggregatedItemsForOrders,
} from './supabaseClient';
import { printOrderEscpos } from './printerManager';
import { printQueue } from './printQueue';
import type {
  OrderListFilter,
  OrderListPage,
  OrderListRow,
  OrderDetailItem,
  OrderActivityLogEntry,
  EditOrderItemPayload,
  FoodOrder,
} from '../shared/types';
import { config } from './config';

/**
 * ordersListManager.ts
 * ---------------------------------------------------------------------------
 * Backs the Orders List page: paginated/filtered listing, per-item view/edit
 * with a full audit trail, order cancel (mandatory reason, manager/owner/
 * admin only) and complete, and manual reprint with session-only duplicate
 * detection.
 *
 * All reads/writes go through the session client and admin-gated,
 * outlet-matched SQL RPCs (see the "ORDERS LIST RPCs" section of
 * db/functions.sql) — same security model as Sales Report and User
 * Management. Mutations raise on the DB side for an unauthorized caller
 * rather than silently no-op'ing, since that's a mutation, not a read.
 * ---------------------------------------------------------------------------
 */

function mapListRow(row: Record<string, unknown>): OrderListRow {
  return {
    orderId: String(row.order_id ?? ''),
    orderNumber: String(row.order_number ?? ''),
    orderType: String(row.order_type ?? ''),
    createdAt: String(row.created_at ?? ''),
    itemCount: Number(row.item_count ?? 0),
    subtotalAmount: Number(row.subtotal_amount ?? 0),
    taxAmount: Number(row.tax_amount ?? 0),
    containerChargeAmount: Number(row.container_charge_amount ?? 0),
    discountAmount: Number(row.discount_amount ?? 0),
    totalAmount: Number(row.total_amount ?? 0),
    status: String(row.status ?? ''),
    hasEdits: row.has_edits === true,
    tableId: row.table_id ? String(row.table_id) : undefined,
    tableNumber: row.table_number ? String(row.table_number) : undefined,
    invoiceNumber: row.invoice_number ? String(row.invoice_number) : undefined,
    orderCount: Number(row.order_count ?? 1),
  };
}

export async function listOrders(filter: OrderListFilter): Promise<OrderListPage> {
  const supabase = getAuthedClient();
  const { data, error } = await supabase.rpc('list_orders', {
    p_outlet_id: config.outletId,
    p_status: filter.status,
    p_search: filter.search?.trim() || null,
    p_from: filter.from ?? null,
    p_to: filter.to ?? null,
    p_page: filter.page,
    p_page_size: filter.pageSize,
  });
  if (error) throw new Error(error.message);

  const rows = ((data ?? []) as Record<string, unknown>[]).map(mapListRow);
  const totalRows = ((data ?? [])[0] as Record<string, unknown> | undefined)?.total_rows;
  return { rows, totalRows: Number(totalRows ?? 0) };
}

export async function getOrderDetail(orderId: string): Promise<OrderDetailItem[]> {
  const supabase = getAuthedClient();
  const { data, error } = await supabase.rpc('get_order_detail', { p_order_id: orderId });
  if (error) throw new Error(error.message);

  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    orderItemId: String(row.order_item_id ?? ''),
    menuItemId: String(row.menu_item_id ?? ''),
    name: String(row.name ?? 'Item'),
    quantity: Number(row.quantity ?? 0),
    unitPrice: Number(row.unit_price ?? 0),
    totalPrice: Number(row.total_price ?? 0),
    isDeleted: row.is_deleted === true,
    editedAt: row.edited_at ? String(row.edited_at) : undefined,
  }));
}

/**
 * Fetches the order id/number pairs for every order sharing one
 * invoice_number, via get_orders_by_invoice() (db/functions.sql) — the RPC
 * is outlet-scoped and re-checks the caller's role itself, so an
 * unauthorized or cross-outlet invoice_number just comes back empty.
 */
async function fetchInvoiceOrders(
  invoiceNumber: string,
): Promise<{ id: string; orderNumber: number }[]> {
  const supabase = getAuthedClient();
  const { data, error } = await supabase.rpc('get_orders_by_invoice', {
    p_invoice_number: invoiceNumber,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row.order_id ?? ''),
    orderNumber: Number(row.order_number ?? 0),
  }));
}

/**
 * Orders List's invoice-grouped row detail — since list_orders() now returns
 * one row per invoice_number rather than one row per order/round (see the
 * "GROUPED BY INVOICE" comment on list_orders in db/functions.sql), opening
 * a row needs every order sharing that invoice back, not just the table's
 * current live batch (fetchTableBatchOrders/getTableOrderDetail below,
 * which is keyed off table_id and excludes completed-and-paid orders). This
 * mirrors getTableOrderDetail's shape/behavior but is keyed on
 * invoice_number directly via get_orders_by_invoice(), so a completed or
 * cancelled invoice still opens correctly from the grid.
 */
export async function getInvoiceOrderDetail(
  invoiceNumber: string,
): Promise<{ orders: { id: string; orderNumber: number }[]; items: OrderDetailItem[] }> {
  const supabase = getAuthedClient();
  const orders = await fetchInvoiceOrders(invoiceNumber);
  const perOrder = await Promise.all(
    orders.map(async (o) => {
      const { data, error } = await supabase.rpc('get_order_detail', { p_order_id: o.id });
      if (error) throw new Error(error.message);
      return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        orderItemId: String(row.order_item_id ?? ''),
        menuItemId: String(row.menu_item_id ?? ''),
        name: String(row.name ?? 'Item'),
        quantity: Number(row.quantity ?? 0),
        unitPrice: Number(row.unit_price ?? 0),
        totalPrice: Number(row.total_price ?? 0),
        isDeleted: row.is_deleted === true,
        editedAt: row.edited_at ? String(row.edited_at) : undefined,
        orderId: o.id,
        orderNumber: o.orderNumber,
      }));
    }),
  );

  return { orders, items: perOrder.flat() };
}

/** Invoice-grouped counterpart to getTableActivityLog — see getInvoiceOrderDetail above. */
export async function getInvoiceActivityLog(invoiceNumber: string): Promise<OrderActivityLogEntry[]> {
  const supabase = getAuthedClient();
  const orders = await fetchInvoiceOrders(invoiceNumber);

  const perOrder = await Promise.all(
    orders.map(async (o) => {
      const { data, error } = await supabase.rpc('get_order_activity_log', { p_order_id: o.id });
      if (error) throw new Error(error.message);
      return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        auditId: String(row.audit_id ?? ''),
        orderItemId: String(row.order_item_id ?? ''),
        itemName: String(row.item_name ?? 'Item'),
        action: row.action === 'delete' ? 'delete' : ('edit' as 'edit' | 'delete'),
        changedAt: String(row.changed_at ?? ''),
        changedByName: String(row.changed_by_name ?? 'Unknown'),
        oldQuantity: row.old_quantity != null ? Number(row.old_quantity) : undefined,
        newQuantity: row.new_quantity != null ? Number(row.new_quantity) : undefined,
        oldUnitPrice: row.old_unit_price != null ? Number(row.old_unit_price) : undefined,
        newUnitPrice: row.new_unit_price != null ? Number(row.new_unit_price) : undefined,
        reason: row.reason ? String(row.reason) : undefined,
        orderNumber: o.orderNumber,
      }));
    }),
  );

  return perOrder.flat();
}

/**
 * Edit/delete history for one order — "Order created" is NOT included here
 * (nothing stores that as an audit row); the caller already has
 * order.createdAt from the list and should prepend it when rendering.
 */
export async function getOrderActivityLog(orderId: string): Promise<OrderActivityLogEntry[]> {
  const supabase = getAuthedClient();
  const { data, error } = await supabase.rpc('get_order_activity_log', { p_order_id: orderId });
  if (error) throw new Error(error.message);

  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    auditId: String(row.audit_id ?? ''),
    orderItemId: String(row.order_item_id ?? ''),
    itemName: String(row.item_name ?? 'Item'),
    action: row.action === 'delete' ? 'delete' : 'edit',
    changedAt: String(row.changed_at ?? ''),
    changedByName: String(row.changed_by_name ?? 'Unknown'),
    oldQuantity: row.old_quantity != null ? Number(row.old_quantity) : undefined,
    newQuantity: row.new_quantity != null ? Number(row.new_quantity) : undefined,
    oldUnitPrice: row.old_unit_price != null ? Number(row.old_unit_price) : undefined,
    newUnitPrice: row.new_unit_price != null ? Number(row.new_unit_price) : undefined,
    reason: row.reason ? String(row.reason) : undefined,
  }));
}

const NOT_EDITABLE_MESSAGE =
  'Not authorized, item not found, or the order is not editable in its current status.';

/**
 * Pre-flight read for editOrderItem/deleteOrderItem — two plain, individually
 * visible-in-logs SELECTs (item, then its parent order's status), gated by
 * the "staff read own outlet order items/orders" RLS policies in
 * db/schema.sql. This exists purely so a bad request fails fast with a clear
 * message before we even attempt the write; it does not by itself authorize
 * anything the write RPC below wouldn't already re-check on its own.
 */
async function assertItemEditable(orderItemId: string): Promise<ReturnType<typeof getAuthedClient>> {
  const supabase = getAuthedClient();

  const { data: item, error: itemErr } = await supabase
    .from('order_items')
    .select('id, order_id')
    .eq('id', orderItemId)
    .single();
  if (itemErr || !item) throw new Error(NOT_EDITABLE_MESSAGE);

  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .select('status')
    .eq('id', (item as { order_id: string }).order_id)
    .single();
  if (orderErr || !order || (order as { status: string }).status !== 'open') {
    throw new Error(NOT_EDITABLE_MESSAGE);
  }

  return supabase;
}

/**
 * The actual mutation — update + audit insert + totals recompute — stays a
 * single security-definer RPC (edit_order_item(), db/functions.sql) rather
 * than several client round trips: those three writes need to succeed or
 * fail together (an edit that updates the item but crashes before the
 * totals recompute would leave the order's displayed total wrong), and
 * Postgres already gives us that atomicity for free inside one function
 * call. The RPC re-validates role/outlet/open-order itself, independent of
 * the read above and of RLS — same as before this change.
 */
export async function editOrderItem(payload: EditOrderItemPayload): Promise<void> {
  const supabase = await assertItemEditable(payload.orderItemId);
  const { error } = await supabase.rpc('edit_order_item', {
    p_order_item_id: payload.orderItemId,
    p_quantity: payload.quantity,
    p_reason: payload.reason ?? null,
  });
  if (error) throw new Error(error.message);
}

export async function deleteOrderItem(orderItemId: string, reason?: string): Promise<void> {
  const supabase = await assertItemEditable(orderItemId);
  const { error } = await supabase.rpc('delete_order_item', {
    p_order_item_id: orderItemId,
    p_reason: reason ?? null,
  });
  if (error) throw new Error(error.message);
}

export async function cancelOrderWithReason(orderId: string, reason: string): Promise<void> {
  const supabase = getAuthedClient();
  const { error } = await supabase.rpc('cancel_order', { p_order_id: orderId, p_reason: reason });
  if (error) throw new Error(error.message);
}

export async function completeOrder(orderId: string): Promise<void> {
  const supabase = getAuthedClient();
  const { error } = await supabase.rpc('complete_order', { p_order_id: orderId });
  if (error) throw new Error(error.message);
}

/**
 * Reprint the bill for an order from the Orders List page. If the order is
 * already completed, this is by definition a reprint of an already-final
 * bill, so it prints with a "DUPLICATE BILL" banner. An active (open) order
 * prints normally — no state to track, no session counting.
 */
export async function reprintOrder(orderId: string): Promise<void> {
  await printQueue.enqueue(async () => {
    const order = await fetchOrderById(orderId);
    if (!order) throw new Error(`Order ${orderId} not found.`);

    // Same aggregation settle uses: non-deleted items only, merged by dish so
    // an edited quantity or a deleted line reflects correctly on the reprint.
    const items = await fetchAggregatedItems(orderId);
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
       
      const group = await fetchTableBatchOrders(tableId);
       if (!group) throw new Error(`Orders found for table ${tableId}`);

      const groupIds = group.orderIds.length > 0 ? group.orderIds : [];

      const order = await fetchOrderById(groupIds[0]);
      if (!order) throw new Error(`Orders found for table ${tableId}`);
  
      const items = await fetchAggregatedItemsForOrders(groupIds);
      const groupOrders = (await Promise.all(groupIds.map((id) => fetchOrderById(id)))).filter(
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

