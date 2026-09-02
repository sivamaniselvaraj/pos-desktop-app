import { getAuthedClient } from './supabaseAuthClient';
import { fetchOrderById, fetchAggregatedItems } from './supabaseClient';
import { printOrderEscpos } from './printerManager';
import type {
  OrderListFilter,
  OrderListPage,
  OrderListRow,
  OrderDetailItem,
  OrderActivityLogEntry,
  EditOrderItemPayload,
} from '../shared/types';

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
  };
}

export async function listOrders(filter: OrderListFilter): Promise<OrderListPage> {
  const supabase = getAuthedClient();
  const { data, error } = await supabase.rpc('list_orders', {
    p_status: filter.status,
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

export async function editOrderItem(payload: EditOrderItemPayload): Promise<void> {
  const supabase = getAuthedClient();
  const { error } = await supabase.rpc('edit_order_item', {
    p_order_item_id: payload.orderItemId,
    p_quantity: payload.quantity,
    p_reason: payload.reason ?? null,
  });
  if (error) throw new Error(error.message);
}

export async function deleteOrderItem(orderItemId: string, reason?: string): Promise<void> {
  const supabase = getAuthedClient();
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
  const order = await fetchOrderById(orderId);
  if (!order) throw new Error(`Order ${orderId} not found.`);

  // Same aggregation settle uses: non-deleted items only, merged by dish so
  // an edited quantity or a deleted line reflects correctly on the reprint.
  const items = await fetchAggregatedItems(orderId);
  const billOrder = { ...order, items };

  const isDuplicate = order.status === 'completed';

  await printOrderEscpos(billOrder, 'Cashier', isDuplicate);
}
