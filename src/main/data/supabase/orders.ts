import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseSettings } from './settings';
import { getAnonClient, getAuthedClient } from './sessionClient';
import { aggregateItems } from '../helpers';
import type { OrderRepository, TableBatch } from '../ports';
import type { FoodOrder, OrderItem, OutletInfo, OrderType, UnprintedKot } from '../../../shared/types';
import { config } from '../../config';

const ITEMS_TABLE = 'order_items';
const ORDER_RPC = 'get_order_with_items';

const getClient = getAuthedClient;

function mapItem(row: Record<string, unknown>): OrderItem {
  const menuItemRaw = row.menu_item ? (row.menu_item as Record<string, unknown>) : null;
  return {
    id: String(row.id ?? row.item_id ?? ''),
    menuItemId: row.menu_item_id != null ? String(row.menu_item_id) : undefined,
    name: menuItemRaw ? String(mapMenuItem(menuItemRaw).name) : 'Item',
    quantity: Number(row.quantity ?? row.qty ?? 1),
    unitPrice: Number(row.price ?? row.unit_price ?? 0),
    specialInstructions: row.special_instructions
      ? String(row.special_instructions)
      : row.notes
        ? String(row.notes)
        : undefined,
    kotPrinted: row.kot_printed === true,
    kotPrintedAt: row.kot_printed_at != null ? String(row.kot_printed_at) : undefined,
  };
}

function mapMenuItem(row: Record<string, unknown>): OutletInfo {
  return {
    id: String(row.id ?? ''),
    name: String(row.name ?? 'Item'),
  };
}

function mapOutlet(row: Record<string, unknown>): OutletInfo {
  return {
    id: String(row.id ?? ''),
    name: String(row.name ?? 'Restaurant'),
    city: row.city ? String(row.city) : undefined,
    phone: row.phone ? String(row.phone) : undefined,
    gstNumber: row.gst_number ? String(row.gst_number) : undefined,
    address: row.address ? String(row.address) : undefined,
    businessName: row.business_name ? String(row.business_name) : undefined,
    receiptHeader: row.receipt_header ? String(row.receipt_header) : undefined,
    receiptFooter: row.receipt_footer ? String(row.receipt_footer) : undefined,
  };
}

function mapRow(row: Record<string, unknown>): FoodOrder {
  const rawItems = Array.isArray(row.items) ? (row.items as Record<string, unknown>[]) : [];
  const outletRaw = row.outlet ? (row.outlet as Record<string, unknown>) : null;

  return {
    id: String(row.id ?? ''),
    orderNumber: Number(row.order_number ?? 0),
    //outletId: row.outlet_id ? String(row.outlet_id) : undefined,
    outlet: outletRaw ? mapOutlet(outletRaw) : undefined,
    customerName: String(row.customer_name ?? ''),
    customerPhone: row.customer_phone ? String(row.customer_phone) : undefined,
    deliveryAddress: row.delivery_address ? String(row.delivery_address) : undefined,
    items: rawItems.map(mapItem),
    // FIX: previously read row.subtotal/row.tax/row.total, but the real
    // orders columns (confirmed via the get_sales_report_uid debugging) are
    // subtotal_amount/tax_amount/total_amount. to_jsonb(o) in
    // get_order_with_items outputs actual column names, so the old keys were
    // always undefined here and silently defaulted to 0 — printed receipts
    // likely showed ₹0.00 tax/total regardless of the real order value.
    subtotal: Number(row.subtotal_amount ?? 0),
    tax: Number(row.tax_amount ?? 0),
    taxBreakdown: Array.isArray(row.tax_breakdown)
      ? (row.tax_breakdown as Record<string, unknown>[]).map((b) => ({
          name: String(b.name ?? 'GST'),
          rate: Number(b.rate ?? 0),
          taxable: Number(b.taxable ?? 0),
          tax: Number(b.tax ?? 0),
        }))
      : undefined,
    total: Number(row.total_amount ?? 0),
    containerCharge: row.container_amount != null ? Number(row.container_amount) : undefined,
    // Inferred from the confirmed subtotal_amount/tax_amount/total_amount/
    // container_charge_amount naming pattern, NOT independently confirmed
    // the way those were — row.discount (bare) was almost certainly the same
    // class of bug as the tax/total mismatch fixed earlier, just silent
    // rather than silently-wrong: the printed "Discount:" line only appears
    // when > 0, so an always-undefined value just meant it never printed.
    discount: row.discount_amount != null ? Number(row.discount_amount) : undefined,
    discountValue: row.discount_value != null ? Number(row.discount_value) : undefined,
    isComplimentary: row.is_complimentary === true,
    orderType: (row.order_type as OrderType) ?? 'pickup',
    tableNumber:
      row.table_number != null ? (row.table_number as string | number) : undefined,
    specialNotes: row.special_notes ? String(row.special_notes) : undefined,
    createdAt: String(row.created_at ?? new Date().toISOString()),
    status: row.status != null ? String(row.status) : undefined,
    isPrinted: row.is_printed === true,
    billPrintedAt: row.printed_at != null ? String(row.printed_at) : undefined,
    placedBy: row.placed_by_name ? String(row.placed_by_name) : undefined,
    invoiceNumber: row.invoice_number ? String(row.invoice_number) : undefined,
    isRunningOrder: row.is_running_order === true,
  };
}

async function fetchOrderFallback(
  supabase: SupabaseClient,
  orderId: string,
): Promise<FoodOrder | null> {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('order_id', orderId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(error.message);
  }
  if (!data) return null;

  const order = mapRow(data as Record<string, unknown>);

  // Fetch outlet separately if not included
  if (!order.outlet && order.outlet) {
    const { data: outletData } = await supabase
      .from('outlets')
      .select('*')
      .eq('id', order.outlet)
      .single();
    if (outletData) {
      order.outlet = mapOutlet(outletData as Record<string, unknown>);
    }
  }

  // Fetch items separately if not included
  if (order.items.length === 0) {
    const { data: items } = await supabase.from(ITEMS_TABLE).select('*').eq('order_id', orderId);
    if (items) order.items = (items as Record<string, unknown>[]).map(mapItem);
  }

  // Fetch the placing staff member's name separately (mapRow only reads
  // placed_by_name, which this raw table select never produces — that's
  // only present when get_order_with_items' RPC does the join).
  if (!order.placedBy) {
    const waiterId = (data as Record<string, unknown>).waiter_id;
    if (waiterId != null) {
      const { data: profileData } = await supabase
        .from('profiles')
        .select('first_name')
        .eq('id', waiterId)
        .single();
      const fullName = (profileData as Record<string, unknown> | null)?.first_name;
      if (fullName) order.placedBy = String(fullName);
    }
  }

  return order;
}

async function fetchOrderById(orderId: string, outletId: string): Promise<FoodOrder | null> {
  const supabase = getClient();
  if (!supabase) throw new Error('Database is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.');

  // Try the RPC first (preferred: single round trip with outlet + items).
  const { data, error } = await supabase.rpc(ORDER_RPC, { p_order_id: orderId, p_outlet_id: outletId});

  if (!error) {
    if (!data) return null;
    return mapRow(data as Record<string, unknown>);
  }

  // Fallback if RPC not installed (42883 = undefined_function, PGRST202 = not in schema cache).
  if (error.code === '42883' || error.code === 'PGRST202') {
    return fetchOrderFallback(supabase, orderId);
  }
  throw new Error(error.message);
}

async function isReachable(): Promise<boolean> {
  const supabase = getClient();
  if (!supabase) return false;
  const { error } = await supabase.from(supabaseSettings.table).select('id').limit(1);
  return !error;
}

async function fetchOutletById(outletId: string): Promise<OutletInfo | null> {
  const supabase = getClient();
  if (!supabase) throw new Error('Database is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.');

  // Plain table read; RLS on outlets limits a signed-in caller to their own organization.
  const { data, error } = await supabase
    .from('outlets')
    .select('id, name, city, phone, gst_number, address, receipt_header, receipt_footer')
    .eq('id', outletId)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw new Error(error.message);

  if (!data) return null;
  return mapOutlet(data as Record<string, unknown>);
}

// ============================================================================
// KOT / SETTLE data access
// ============================================================================
//
// #4 SEAM — "which order does this print target?"
// -----------------------------------------------------------------------------
// Every function below resolves the working set from an ORDER id. This is the
// interim decision: the print request carries orderId, so we key on it. If we
// later decide KOT/settle should key on table_id (one open order per table),
// ONLY resolveOrderId() below needs to change — swap it for a table->open-order
// lookup and the rest of the pipeline is unaffected.
// -----------------------------------------------------------------------------

const ITEMS_TABLE_NAME = 'order_items';

/**
 * #4 SEAM. Resolve the concrete order id the print applies to. Today this is a
 * pass-through (request already carries the order id). Later this can become a
 * table_id -> open order lookup without touching callers.
 */
async function resolveOrderId(orderId: string): Promise<string | null> {
  return orderId ? orderId : null;
}


/** Fetch the order's status (null if order not found / no status column). */
async function getOrderStatus(orderId: string): Promise<string | null> {
  const supabase = getClient();
  if (!supabase) throw new Error('Database is not configured.');
  const id = await resolveOrderId(orderId);
  if (!id) return null;

  const { data, error } = await supabase
    .from(supabaseSettings.table)
    .select('status')
    .eq('id', id)
    .single();
  if (error) return null;
  const status = (data as Record<string, unknown>)?.status;
  return status != null ? String(status) : null;
}

async function isOrderInOutlet(orderId: string, outletId: string): Promise<boolean> {
  const supabase = getClient();
  if (!supabase) throw new Error('Database is not configured.');
  const { data, error } = await supabase
    .from(supabaseSettings.table)
    .select('outlet_id')
    .eq('id', orderId)
    .maybeSingle();
  if (error) {
    if (error.code === '22P02') return false; // not a valid id for this column
    throw new Error(error.message);
  }
  return !!data && String((data as Record<string, unknown>).outlet_id) === outletId;
}

/**
 * KOT read: items for this order that have NOT yet been sent to the kitchen
 * (kot_printed = false). This is the delta to print on a confirm.
 */
async function fetchUnprintedItems(orderId: string): Promise<OrderItem[]> {
  const supabase = getClient();
  if (!supabase) throw new Error('Database is not configured.');
  const id = await resolveOrderId(orderId);
  if (!id) return [];
  const { data, error } = await supabase
    .from(ITEMS_TABLE_NAME)
    .select('*, menu_item:menu_items!menu_item_id(id, name)')
    .eq('order_id', id)
    .eq('kot_printed', false);
  if (error) throw new Error(error.message);
  return (data as Record<string, unknown>[] | null)?.map(mapItem) ?? [];
}

async function checkForRunningOrder(orderId: string): Promise<number|0> {
  const supabase = getClient();
  if (!supabase) throw new Error('Database is not configured.');
  const id = await resolveOrderId(orderId);
  if (!id) return 0;

  // 2. Open orders of the same outlet on the same invoice, plus the order itself
  const { count, error: e2 } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('outlet_id', config.outletId)
    .eq('invoice_number', id)
    .not('status', 'in', '(completed,cancelled)');
    
  if (e2) throw new Error(e2.message);
  return count ?? 0;
}



/**
 * KOT claim: atomically take the unprinted items of this order (see
 * claim_kot_items). Only the items this call won are returned, so two
 * callers can never print the same item.
 */
async function claimUnprintedItems(orderId: string): Promise<OrderItem[]> {
  const supabase = getClient();
  if (!supabase) throw new Error('Database is not configured.');
  const id = await resolveOrderId(orderId);
  if (!id) return [];

  const { data: claimed, error } = await supabase.rpc('claim_kot_items', { p_order_id: id });
  if (error) throw new Error(error.message);
  const ids = ((claimed ?? []) as unknown[]).map((v) => String(typeof v === 'object' && v ? Object.values(v)[0] : v));
  if (ids.length === 0) return [];

  const { data, error: readErr } = await supabase.from(ITEMS_TABLE_NAME).select('*').in('id', ids);
  if (readErr) {
    await releaseKotClaim(ids).catch(() => undefined);
    throw new Error(readErr.message);
  }
  return (data as Record<string, unknown>[] | null)?.map(mapItem) ?? [];
}

async function releaseKotClaim(itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  const supabase = getClient();
  if (!supabase) throw new Error('Database is not configured.');
  const { error } = await supabase.rpc('release_kot_claim', { p_item_ids: itemIds });
  if (error) throw new Error(error.message);
}

/**
 * KOT write: stamp exactly the given item rows as sent to the kitchen.
 * Called AFTER a successful KOT print so a failed print doesn't lose the delta.
 */
async function markItemsKotPrinted(itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  const supabase = getClient();
  if (!supabase) throw new Error('Database is not configured.');

  const { error } = await supabase
    .from(ITEMS_TABLE_NAME)
    .update({ kot_printed: true, kot_printed_at: new Date().toISOString() })
    .in('id', itemIds);
  if (error) throw new Error(error.message);
}

/**
 * Settle read: ALL non-deleted items for the order (KOT state ignored),
 * aggregated by menuItemId so repeat orders of the same dish merge into one
 * bill line (2 + 3 Kulcha -> 5). unit_price is stable per day, so menuItemId
 * alone is a safe merge key. Falls back to item name when menuItemId is
 * absent. Excludes soft-deleted items (order_items.is_deleted) — see the
 * Orders List item-editing feature, db/schema.sql.
 */
async function fetchAggregatedItems(orderId: string): Promise<OrderItem[]> {
  const supabase = getClient();
  if (!supabase) throw new Error('Database is not configured.');
  const id = await resolveOrderId(orderId);
  if (!id) return [];

  const { data, error } = await supabase
    .from(ITEMS_TABLE_NAME)
    .select('*, menu_item:menu_items!menu_item_id(id, name)')
    .eq('order_id', id)
    .eq('is_deleted', false);
  if (error) throw new Error(error.message);
  return aggregateItems((data as Record<string, unknown>[] | null)?.map(mapItem) ?? []);
}

/**
 * Fetches full order rows for a set of order NUMBERS in one query — the
 * other half of the settle simplification: orderManager.handleSettleByNumbers
 * calls this ONCE and gets everything it needs (id, totals, status, etc. for
 * every order in the batch) instead of a separate per-order fetchOrderById
 * loop. Scoped to outletId since order_number is only unique WITHIN an
 * outlet. Cancelled orders are excluded; a takeaway settle passes a
 * single-element array and gets back that one order (or none, if it's been
 * cancelled or doesn't exist for this outlet).
 */
async function fetchOrdersByInvoiceNumbers(
  invoiceNumber: string,
  outletId: string,
): Promise<FoodOrder[]> {
  if (invoiceNumber.trim() === '') return [];
  const supabase = getClient();
  if (!supabase) throw new Error('Database is not configured.');

  const { data, error } = await supabase
    .from('orders')
    .select(`*, outlet:outlets!outlet_id(id, name, address, phone, email, gst_number, receipt_footer, business_name, receipt_header)`)
    .eq('invoice_number', invoiceNumber)
    .eq('outlet_id', outletId)
    .neq('status', 'cancelled');
  if (error) throw new Error(error.message);
  return ((data as Record<string, unknown>[] | null) ?? []).map(mapRow);
}

/**
 * Aggregated items across MULTIPLE orders (a whole table's open rounds,
 * merged into one bill) — same merge-by-menuItemId logic as
 * fetchAggregatedItems above, just spanning several order_ids instead of one.
 */
async function fetchAggregatedItemsForOrders(orderIds: string[]): Promise<OrderItem[]> {
  if (orderIds.length === 0) return [];
  const supabase = getClient();
  if (!supabase) throw new Error('Database is not configured.');

  const { data, error } = await supabase
    .from(ITEMS_TABLE_NAME)
    .select('*, menu_item:menu_items!menu_item_id(id, name)')
    .in('order_id', orderIds)
    .eq('is_deleted', false);
  if (error) throw new Error(error.message);

  return aggregateItems((data as Record<string, unknown>[] | null)?.map(mapItem) ?? []);
}

/**
 * Records that the bill for these orders has printed: is_printed = true and
 * printed_at = now, but only on orders not printed before, so printed_at keeps
 * the FIRST print time and a reprint changes nothing.
 */
async function markOrdersBillPrinted(orderIds: string[]): Promise<void> {
  if (orderIds.length === 0) return;
  const supabase = getClient();
  if (!supabase) throw new Error('Database is not configured.');

  const { error } = await supabase
    .from('orders')
    .update({ is_printed: true, printed_at: new Date().toISOString() })
    .in('id', orderIds)
    .eq('is_printed', false);
  if (error) throw new Error(error.message);
}

/**
 * Open orders of the caller's outlet that still have items not sent to the
 * kitchen. One RPC (find_orders_with_pending_kot); the function applies the
 * orders.view permission and the outlet scope itself.
 */
async function findOrdersWithPendingKot(): Promise<{ orderId: string; orderType: string }[]> {
  const { data, error } = await getAuthedClient().rpc('find_orders_with_pending_kot');
  if (error) throw new Error(error.message);
  return ((data ?? []) as { order_id: string; order_type: string }[]).map((r) => ({
    orderId: String(r.order_id),
    orderType: r.order_type,
  }));
}

async function listUnprintedKots(): Promise<UnprintedKot[]> {
  const { data, error } = await getAuthedClient().rpc('get_unprinted_kots');
  if (error) throw new Error(error.message);
  type Row = {
    order_id: string;
    order_number: number;
    order_type: string;
    table_number: string | null;
    customer_name: string | null;
    waiter_name: string | null;
    special_notes: string | null;
    placed_at: string;
    order_source: string | null;
    device_name: string | null;
    items: { name: string; quantity: number; note: string | null }[] | null;
  };
  return ((data ?? []) as Row[]).map((r) => ({
    orderId: String(r.order_id),
    orderNumber: r.order_number,
    orderType: r.order_type,
    tableNumber: r.table_number ?? undefined,
    customerName: r.customer_name ?? undefined,
    waiterName: r.waiter_name ?? undefined,
    specialNotes: r.special_notes ?? undefined,
    placedAt: r.placed_at,
    orderSource: r.order_source === 'mobile' ? 'mobile' : 'pos',
    deviceName: r.device_name ?? undefined,
    items: (r.items ?? []).map((i) => ({ name: i.name, quantity: i.quantity, note: i.note ?? undefined })),
  }));
}

export const orders: OrderRepository = {
  isReachable,
  fetchOrderById,
  fetchOutletById,
  getOrderStatus,
  isOrderInOutlet,
  fetchUnprintedItems,
  markItemsKotPrinted,
  fetchAggregatedItems,
  fetchAggregatedItemsForOrders,
  fetchOrdersByInvoiceNumbers,
  markOrdersBillPrinted,
  findOrdersWithPendingKot,
  listUnprintedKots,
  claimUnprintedItems,
  releaseKotClaim,
  checkForRunningOrder,
};
