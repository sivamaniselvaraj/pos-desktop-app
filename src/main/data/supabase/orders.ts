import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseSettings } from './settings';
import { getAnonClient, getAuthedClient } from './sessionClient';
import { aggregateItems } from '../helpers';
import type { OrderRepository, TableBatch } from '../ports';
import type { FoodOrder, OrderItem, OutletInfo, OrderType } from '../../../shared/types';

const ITEMS_TABLE = 'order_items';
const ORDER_RPC = 'get_order_with_items';

const getClient = getAnonClient;

function mapItem(row: Record<string, unknown>): OrderItem {
  return {
    id: String(row.id ?? row.item_id ?? ''),
    menuItemId: row.menu_item_id != null ? String(row.menu_item_id) : undefined,
    name: String(row.name ?? row.item_name ?? 'Item'),
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

function mapOutlet(row: Record<string, unknown>): OutletInfo {
  return {
    id: String(row.id ?? ''),
    name: String(row.name ?? 'Restaurant'),
    city: row.city ? String(row.city) : undefined,
    phone: row.phone ? String(row.phone) : undefined,
    gstNumber: row.gst_number ? String(row.gst_number) : undefined,
    address: row.address ? String(row.address) : undefined,
  };
}

function mapRow(row: Record<string, unknown>): FoodOrder {
  const rawItems = Array.isArray(row.items) ? (row.items as Record<string, unknown>[]) : [];
  const outletRaw = row.outlet ? (row.outlet as Record<string, unknown>) : null;

  return {
    id: String(row.id ?? ''),
    orderId: String(row.order_id ?? ''),
    orderNumber: Number(row.order_number ?? 0),
    //outletId: row.outlet_id ? String(row.outlet_id) : undefined,
    outlet: outletRaw ? mapOutlet(outletRaw) : undefined,
    customerName: String(row.customer_name ?? 'Unknown'),
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
    total: Number(row.total_amount ?? 0),
    containerCharge: row.container_charge_amount != null ? Number(row.container_charge_amount) : undefined,
    // Inferred from the confirmed subtotal_amount/tax_amount/total_amount/
    // container_charge_amount naming pattern, NOT independently confirmed
    // the way those were — row.discount (bare) was almost certainly the same
    // class of bug as the tax/total mismatch fixed earlier, just silent
    // rather than silently-wrong: the printed "Discount:" line only appears
    // when > 0, so an always-undefined value just meant it never printed.
    discount: row.discount_amount != null ? Number(row.discount_amount) : undefined,
    orderType: (row.order_type as OrderType) ?? 'pickup',
    tableNumber:
      row.table_number != null ? (row.table_number as string | number) : undefined,
    specialNotes: row.special_notes ? String(row.special_notes) : undefined,
    createdAt: String(row.created_at ?? new Date().toISOString()),
    status: row.status != null ? String(row.status) : undefined,
    placedBy: row.placed_by_name ? String(row.placed_by_name) : undefined,
    invoiceNumber: row.invoice_number ? String(row.invoice_number) : undefined,
  };
}

async function fetchOrderFallback(
  supabase: SupabaseClient,
  orderId: string,
): Promise<FoodOrder | null> {
  const { data, error } = await supabase
    .from(supabaseSettings.table)
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

async function fetchOrderById(orderId: string): Promise<FoodOrder | null> {
  const supabase = getClient();
  if (!supabase) throw new Error('Database is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.');

  // Try the RPC first (preferred: single round trip with outlet + items).
  const { data, error } = await supabase.rpc(ORDER_RPC, { p_order_id: orderId });

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
    .select('id, name, city, phone, gst_number, address')
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
    .select('*')
    .eq('order_id', id)
    .eq('kot_printed', false);
  if (error) throw new Error(error.message);
  return (data as Record<string, unknown>[] | null)?.map(mapItem) ?? [];
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
    .select('*')
    .eq('order_id', id)
    .eq('is_deleted', false);
  if (error) throw new Error(error.message);

  return aggregateItems((data as Record<string, unknown>[] | null)?.map(mapItem) ?? []);
}

/**
 * #4 SEAM resolved: settle/reprint now key on the ORDER's TABLE, not just the
 * order itself. A table can carry several separate dine-in orders at once
 * (rounds ordered before anyone settled), so this gathers every order
 * sharing that table_id that's still part of the "current batch" — mirrors
 * list_tables_for_outlet()'s batch definition (db/functions.sql): not
 * cancelled, and not already completed-AND-paid. That covers both cases
 * this is called from: pre-settle (orders still open) and post-settle
 * reprint (orders completed, payment not yet recorded). Non-dine-in orders
 * (table_id null) have nothing to group with — this just returns the order
 * itself.
 */

async function fetchTableBatchOrders(orderId: string): Promise<TableBatch> {
  const supabase = getClient();
  if (!supabase) throw new Error('Database is not configured.');
  const id = await resolveOrderId(orderId);
  if (!id) return { tableId: null, orderIds: [], orderNumbers: [], orders: [] };

  const { data: current, error: curErr } = await supabase
    .from(supabaseSettings.table)
    .select('table_id, order_number')
    .eq('id', id)
    .single();
  if (curErr) throw new Error(curErr.message);
  const currentRow = current as Record<string, unknown> | null;
  const tableId = currentRow?.table_id != null ? String(currentRow.table_id) : null;

  if (!tableId) {
    // Pickup/delivery, or a dine-in order somehow missing its table link —
    // nothing to group with, just this one order.
    const orderNumber = currentRow?.order_number != null ? Number(currentRow.order_number) : null;
    return {
      tableId: null,
      orderIds: [id],
      orderNumbers: orderNumber != null ? [orderNumber] : [],
      orders: orderNumber != null ? [{ id, orderNumber }] : [{ id, orderNumber: 0 }],
    };
  }

  const { data: rows, error } = await supabase
    .from(supabaseSettings.table)
    .select('id, order_number, status, payment_details')
    .eq('table_id', tableId)
    .neq('status', 'cancelled');
  if (error) throw new Error(error.message);

  const list = ((rows as Record<string, unknown>[] | null) ?? []).filter((r) => {
    // Exclude only orders that are BOTH completed AND already paid — those
    // are done and out of the batch. Everything else (still open, or
    // completed-but-unpaid awaiting the Save button) stays in.
    const isPaidAndDone = r.status === 'completed' && r.payment_details != null;
    return !isPaidAndDone;
  });

  let pairs = list.map((r) => ({ id: String(r.id), orderNumber: Number(r.order_number) }));
  // Defensive: the triggering order should always satisfy the filter above,
  // but include it explicitly in case of a race with a concurrent edit.
  if (!pairs.some((p) => p.id === id)) {
    const orderNumber = currentRow?.order_number != null ? Number(currentRow.order_number) : 0;
    pairs.push({ id, orderNumber });
  }
  pairs = pairs.sort((a, b) => a.orderNumber - b.orderNumber);

  return {
    tableId,
    orderIds: pairs.map((p) => p.id),
    orderNumbers: pairs.map((p) => p.orderNumber),
    orders: pairs,
  };
}

/**
 * Resolves a DINE-IN table number to the list of order NUMBERS currently in
 * that table's settle batch — same "not cancelled, not completed-and-paid"
 * condition fetchTableBatchOrders uses, just returning order_number instead
 * of order id/uuid. This is the httpServer-side half of the settle
 * simplification: knowing up front this is a dine-in table (via the
 * request's orderType) means going straight to the table's full order list
 * in ONE query, rather than first resolving one "anchor" order id and then
 * having handleSettle re-discover the same batch a second time.
 *
 * Scoped to outletId since table_number is only unique WITHIN an outlet.
 * Returns null if the table itself doesn't exist for this outlet (distinct
 * from an empty array, which means the table exists but has nothing
 * outstanding to settle).
 */
async function fetchTableOrderNumbers(
  tableNumber: string,
  outletId: string,
): Promise<number[] | null> {
  const supabase = getClient();
  if (!supabase) throw new Error('Database is not configured.');

  const { data: tableRow, error: tableErr } = await supabase
    .from('tables')
    .select('id')
    .eq('table_number', tableNumber)
    .eq('outlet_id', outletId)
    .maybeSingle();
  if (tableErr) throw new Error(tableErr.message);
  const tableId = (tableRow as Record<string, unknown> | null)?.id;
  if (!tableId) return null;

  const { data: rows, error } = await supabase
    .from(supabaseSettings.table)
    .select('order_number, status, payment_details')
    .eq('table_id', tableId)
    .neq('status', 'cancelled');
  if (error) throw new Error(error.message);

  return ((rows as Record<string, unknown>[] | null) ?? [])
    .filter((r) => !(r.status === 'completed' && r.payment_details != null))
    .map((r) => Number(r.order_number));
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
async function fetchOrdersByNumbers(
  orderNumbers: number[],
  outletId: string,
): Promise<FoodOrder[]> {
  if (orderNumbers.length === 0) return [];
  const supabase = getClient();
  if (!supabase) throw new Error('Database is not configured.');

  const { data, error } = await supabase
    .from(supabaseSettings.table)
    .select('*')
    .in('order_number', orderNumbers)
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
    .select('*')
    .in('order_id', orderIds)
    .eq('is_deleted', false);
  if (error) throw new Error(error.message);

  return aggregateItems((data as Record<string, unknown>[] | null)?.map(mapItem) ?? []);
}

/**
 * Marks every order in `orderIds` completed (settled_at stamped). Deliberately
 * does NOT free the table — that only happens once payment is recorded for
 * the whole batch via save_order_payment() (db/functions.sql), triggered
 * from the Table Dashboard's Save button. This mirrors complete_order()'s
 * table-batch model but runs over the anon key (no user session) since this
 * is the Android settle-print path.
 */
async function markOrdersCompleted(orderIds: string[]): Promise<void> {
  if (orderIds.length === 0) return;
  const supabase = getClient();
  if (!supabase) throw new Error('Database is not configured.');

  const { error } = await supabase
    .from(supabaseSettings.table)
    .update({ status: 'completed', settled_at: new Date().toISOString() })
    .in('id', orderIds);
  if (error) throw new Error(error.message);
}


/**
 * Orders of the signed-in user's outlet that are open and still have unprinted
 * kitchen items. Unprinted items first (usually none, so the common 30s tick
 * is one cheap query), then which of their orders are still open. Both reads
 * are limited by RLS to the caller's own outlet (orders.view).
 */
async function findOrdersWithPendingKot(): Promise<{ orderId: string; orderType: string }[]> {
  const supabase = getAuthedClient();
  const pending = await supabase
    .from('order_items')
    .select('order_id')
    .eq('is_deleted', false)
    .eq('kot_printed', false);
  if (pending.error) throw new Error(pending.error.message);
  const orderIds = [...new Set(((pending.data ?? []) as { order_id: string }[]).map((r) => String(r.order_id)))];
  if (orderIds.length === 0) return [];

  const { data, error } = await supabase.from('orders').select('id, order_type').in('id', orderIds)
  .eq('status', 'preparing');
  if (error) throw new Error(error.message);
  return ((data ?? []) as { id: string; order_type: string }[]).map((r) => ({
    orderId: String(r.id),
    orderType: r.order_type,
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
  fetchTableBatchOrders,
  fetchTableOrderNumbers,
  fetchOrdersByNumbers,
  markOrdersCompleted,
  findOrdersWithPendingKot,
};
