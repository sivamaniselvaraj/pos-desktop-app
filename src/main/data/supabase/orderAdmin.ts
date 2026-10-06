import { getAuthedClient } from './sessionClient';
import type { ActivityLogRecord, InvoiceItemRecord, InvoiceOrderRef, OrderAdminRepository } from '../ports';
import type { EditorApproval, OrderListRow } from '../../../shared/types';

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
    tableId: row.table_id ? String(row.table_id) : undefined,
    tableNumber: row.table_number ? String(row.table_number) : undefined,
    invoiceNumber: row.invoice_number ? String(row.invoice_number) : undefined,
    orderCount: Number(row.order_count ?? 1),
    cancelledCount: Number(row.cancelled_count ?? 0),
  };
}

/**
 * The write functions return jsonb: {ok:true} on success or {ok:false,error}
 * when the editor credentials are rejected (returned rather than raised so the
 * failed-attempt log row used for lockout survives the transaction).
 * Authorization failures still raise and arrive as `error`.
 */
function unwrapApprovalResult(data: unknown): void {
  const d = data as { ok?: boolean; error?: string } | null;
  if (d && d.ok === false) throw new Error(d.error ?? 'Approval failed');
}

function approvalParams(approval: EditorApproval | undefined) {
  return {
    p_editor_username: (approval?.username ?? '').trim(),
    p_editor_password: approval?.password ?? '',
  };
}

export const orderAdmin: OrderAdminRepository = {
  async listOrders(outletId, filter) {
    const { data, error } = await getAuthedClient().rpc('list_orders', {
      p_outlet_id: outletId,
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
  },

  // Plain read; RLS ("staff read own outlet orders") needs orders.view and the
  // caller's own outlet, so a foreign or unauthorized invoice number is empty.
  async listInvoiceOrders(invoiceNumber): Promise<InvoiceOrderRef[]> {
    const { data, error } = await getAuthedClient()
      .from('orders')
      .select('id, order_number, status')
      .eq('invoice_number', invoiceNumber)
      .order('order_number', { ascending: true });
    if (error) throw new Error(error.message);
    return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id ?? ''),
      orderNumber: Number(row.order_number ?? 0),
      status: String(row.status ?? ''),
    }));
  },

  // One read for every order's items and one for the item names (merged here
  // rather than an embedded join). RLS ("staff read own outlet order items").
  async listItemsForOrders(orderIds): Promise<InvoiceItemRecord[]> {
    if (orderIds.length === 0) return [];
    const supabase = getAuthedClient();
    const { data, error } = await supabase
      .from('order_items')
      .select('id, order_id, menu_item_id, quantity, unit_price, total_price, is_deleted, edited_at')
      .in('order_id', orderIds)
      .order('id');
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];

    const menuIds = [...new Set(rows.map((r) => String(r.menu_item_id ?? '')).filter(Boolean))];
    const names = new Map<string, string>();
    if (menuIds.length > 0) {
      const menu = await supabase.from('menu_items').select('id, name').in('id', menuIds);
      if (menu.error) throw new Error(menu.error.message);
      for (const m of (menu.data ?? []) as { id: string; name: string }[]) names.set(String(m.id), m.name);
    }

    return rows.map((row) => ({
      orderItemId: String(row.id ?? ''),
      menuItemId: String(row.menu_item_id ?? ''),
      name: names.get(String(row.menu_item_id)) ?? 'Item',
      quantity: Number(row.quantity ?? 0),
      unitPrice: Number(row.unit_price ?? 0),
      totalPrice: Number(row.total_price ?? 0),
      isDeleted: row.is_deleted === true,
      editedAt: row.edited_at ? String(row.edited_at) : undefined,
      orderId: String(row.order_id),
    }));
  },

  async getOrderActivityLog(orderId): Promise<ActivityLogRecord[]> {
    const { data, error } = await getAuthedClient().rpc('get_order_activity_log', { p_order_id: orderId });
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
    }));
  },

  // Two plain reads (item, then its order's status) gated by the "staff read
  // own outlet ..." RLS policies. Purely a fast-fail; the write function
  // re-checks everything itself.
  async isItemEditable(orderItemId) {
    const supabase = getAuthedClient();
    const { data: item, error: itemErr } = await supabase
      .from('order_items')
      .select('id, order_id')
      .eq('id', orderItemId)
      .single();
    if (itemErr || !item) return false;
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('status')
      .eq('id', (item as { order_id: string }).order_id)
      .single();
    return !(orderErr || !order || (order as { status: string }).status !== 'open');
  },

  // update + audit insert + totals recompute stay ONE security-definer function:
  // they must succeed or fail together.
  async editItem(a) {
    const { data, error } = await getAuthedClient().rpc('edit_order_item', {
      p_outlet_id: a.outletId,
      p_order_item_id: a.orderItemId,
      p_quantity: a.quantity,
      p_reason: a.reason,
      ...approvalParams(a.approval),
    });
    if (error) throw new Error(error.message);
    unwrapApprovalResult(data);
  },

  async deleteItem(a) {
    const { data, error } = await getAuthedClient().rpc('delete_order_item', {
      p_outlet_id: a.outletId,
      p_order_item_id: a.orderItemId,
      p_reason: a.reason,
      ...approvalParams(a.approval),
    });
    if (error) throw new Error(error.message);
    unwrapApprovalResult(data);
  },

  async cancelOrder(a) {
    const { data, error } = await getAuthedClient().rpc('cancel_order', {
      p_outlet_id: a.outletId,
      p_order_id: a.orderId,
      p_reason: a.reason,
      ...approvalParams(a.approval),
    });
    if (error) throw new Error(error.message);
    unwrapApprovalResult(data);
  },

  async cancelInvoice(a) {
    const { data, error } = await getAuthedClient().rpc('cancel_invoice', {
      p_outlet_id: a.outletId,
      p_invoice_number: a.invoiceNumber,
      p_reason: a.reason,
      ...approvalParams(a.approval),
    });
    if (error) throw new Error(error.message);
    unwrapApprovalResult(data);
  },

  async completeOrder(orderId) {
    const { error } = await getAuthedClient().rpc('complete_order', { p_order_id: orderId });
    if (error) throw new Error(error.message);
  },
};
