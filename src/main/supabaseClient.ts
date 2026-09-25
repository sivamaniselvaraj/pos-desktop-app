import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config, isConfigured } from './config';
import { getAuthedClient } from './supabaseAuthClient';
import type {
  FoodOrder,
  HeaderConfig,
  OrderItem,
  OutletInfo,
  OrderType,
  ReportBucket,
  SalesReportRow,
  TopItemRow,
  SalesByOrderTypeRow,
  SalesByTypeBucketRow,
} from '../shared/types';

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (!isConfigured()) return null;
  if (!client) {
    client = createClient(config.supabase.url, config.supabase.anonKey);
  }
  return client;
}

function mapItem(row: Record<string, unknown>): OrderItem {
  return {
    id: String(row.id ?? row.item_id ?? ''),
    menuItemId: row.menu_item_id != null ? String(row.menu_item_id) : undefined,
    name: String(row.name ?? row.item_name ?? 'Item'),
    quantity: Number(row.quantity ?? row.qty ?? 1),
    unit_price: Number(row.price ?? row.unit_price ?? 0),
    total_price: Number(row.total_amount ?? row.total_amount ?? 0),
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

function mapHeaderConfig(row: Record<string, unknown>): HeaderConfig {
  return {
    restaurantName: row.restaurantName ? String(row.restaurantName ?? '') : undefined,
    headerText: row.headerText ? String(row.headerText ?? 'Restaurant') : undefined,
    footerText: row.footerText ? String(row.footerText) : undefined,
    containerChargePercent: row.containerChargePercent
      ? String(row.containerChargePercent)
      : undefined,
  };
}

// Maps a raw DB row (snake_case) into our camelCase FoodOrder.
function mapRow(row: Record<string, unknown>): FoodOrder {
  const items = (row.items as OrderItem[]) ?? [];
  //const rawItems = Array.isArray(row.items) ? (row.items as Record<string, unknown>[]) : [];
  const outletRaw = row.outlet ? (row.outlet as Record<string, unknown>) : null;
  const headerConfigRaw = row.headerConfig ? (row.headerConfig as Record<string, unknown>) : null;
  return {
    id: String(row.id ?? ''),
    orderId: String(row.id ?? ''),
    orderNumber: Number(row.order_number ?? 0),
    tableNumber: Number(row.table_number ?? 0),
    tokenNumber: Number(row.token_number ?? 0),
    outlet: outletRaw ? mapOutlet(outletRaw) : undefined,
    customerName: String(row.customer_name ?? 'Unknown'),
    customerPhone: row.customer_phone ? String(row.customer_phone) : undefined,
    deliveryAddress: row.delivery_address ? String(row.delivery_address) : undefined,
    items,
    subtotal: Number(row.subtotal ?? 0),
    tax: Number(row.tax_amount ?? 0),
    total: Number(row.total_amount ?? 0),
    discount: row.discount_amount ? Number(row.discount_amount) : undefined,
    containerCharge: row.container_charge_amount != null ? Number(row.container_charge_amount) : undefined,
    orderType: (row.order_type as OrderType) ?? 'pickup',
    specialNotes: row.special_notes ? String(row.special_notes) : undefined,
    createdAt: String(row.created_at ?? new Date().toISOString()),
    status: row.status != null ? String(row.status) : undefined,
    placedBy: row.placed_by_name ? String(row.placed_by_name) : undefined,
    headerConfig: headerConfigRaw ? mapHeaderConfig(headerConfigRaw) : undefined,
  };
}

export async function fetchOrderById(orderId: string): Promise<FoodOrder | null> {
  const supabase = getClient();
  if (!supabase)
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.');

  const { data, error } = await supabase.rpc('get_order_with_items', { p_order_id: orderId });

  if (error) {
    if (error.code === 'PGRST116') return null; // no rows
    throw new Error(error.message);
  }
  return data ? mapRow(data as Record<string, unknown>) : null;
}
export async function loadSettings(outletId: string): Promise<FoodOrder | null> {
  return null;
}

export async function isDatabaseReachable(): Promise<boolean> {
  const supabase = getClient();
  if (!supabase) return false;
  const { error } = await supabase.from(config.supabase.orderTable).select('id').limit(1);
  return !error;
}

export async function fetchOutletById(outletId: string): Promise<OutletInfo | null> {
  const supabase = getClient();
  if (!supabase)
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.');

  const { data, error } = await supabase.rpc('get_outlet_by_id', { p_outlet_id: outletId });

  if (error) {
    if (error.code === '42883' || error.code === 'PGRST202') {
      // RPC not installed; fall back to direct query.
      const { data: outletData, error: queryError } = await supabase
        .from('outlets')
        .select('id, name, city, phone, gst_number, address')
        .eq('id', outletId)
        .eq('is_active', true)
        .single();
      if (queryError) return null;
      return outletData ? mapOutlet(outletData as Record<string, unknown>) : null;
    }
    throw new Error(error.message);
  }

  if (!data) return null;
  return mapOutlet(data as Record<string, unknown>);
}

export async function fetchMenuItemsForOutlet(outletId:string): Promise<Record<string, unknown>[]> {

    const supabase = getClient();
  if (!supabase)
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.');

    const { data, error } = await supabase.rpc('get_menu_items_for_outlet', {
      p_outlet_id: outletId,
    });
    if (error) throw new Error(error.message);

     if (!data) return [];
    return (data ?? []) as Record<string, unknown>[];
   
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

/** Order status used to gate settle idempotency and table reuse. */
export type OrderStatus = 'open' | 'settled' | string;

/** Fetch the order's status (null if order not found / no status column). */
export async function getOrderStatus(orderId: string): Promise<OrderStatus | null> {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const id = await resolveOrderId(orderId);
  if (!id) return null;

  const { data, error } = await supabase
    .from(config.supabase.orderTable)
    .select('status')
    .eq('id', id)
    .single();
  if (error) return null;
  const status = (data as Record<string, unknown>)?.status;
  return status != null ? String(status) : null;
}

/**
 * KOT read: items for this order that have NOT yet been sent to the kitchen
 * (kot_printed = false). This is the delta to print on a confirm.
 */
export async function fetchUnprintedItems(orderId: string): Promise<OrderItem[]> {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const id = await resolveOrderId(orderId);
  if (!id) return [];

  const { data, error } = await supabase.rpc('get_pending_kot_items', { p_order_id: orderId });
  if (error) throw new Error(error.message);
  return (data as Record<string, unknown>[] | null)?.map(mapItem) ?? [];
}

/**
 * KOT write: stamp exactly the given item rows as sent to the kitchen.
 * Called AFTER a successful KOT print so a failed print doesn't lose the delta.
 */
export async function markItemsKotPrinted(orderId: string): Promise<void> {
  if (orderId.length === 0) return;
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase is not configured.');

  const { error } = await supabase.rpc('mark_order_kot_printed', { p_order_id: orderId });
  if (error) throw new Error(error.message);
}

/**
 * Settle read: ALL items for the order (KOT state ignored), aggregated by
 * menuItemId so repeat orders of the same dish merge into one bill line
 * (2 + 3 Kulcha -> 5). unit_price is stable per day, so menuItemId alone is a
 * safe merge key. Falls back to item name when menuItemId is absent.
 */
export async function fetchAggregatedItems(orderId: string): Promise<OrderItem[]> {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const id = await resolveOrderId(orderId);
  if (!id) return [];

  const { data, error } = await supabase
  .from(ITEMS_TABLE_NAME)
  .select('*')
  .eq('order_id', id)
  .eq('is_deleted', false);
  if (error) throw new Error(error.message);

  const rows = (data as Record<string, unknown>[] | null)?.map(mapItem) ?? [];

  const merged = new Map<string, OrderItem>();
  for (const item of rows) {
    const key = item.menuItemId ?? `name:${item.name}`;
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      merged.set(key, { ...item });
    }
  }
  return Array.from(merged.values());
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
export interface TableBatch {
  tableId: string | null;
  orderIds: string[];
  orderNumbers: number[];
  /** orderIds and orderNumbers zipped together, sorted by orderNumber — the pairing the caller usually actually wants. */
  orders: { id: string; orderNumber: number }[];
}

export async function fetchTableBatchOrders(orderId: string): Promise<TableBatch> {
  const supabase = getAuthedClient();
  if (!supabase) throw new Error('Supabase is not configured.');

  const id = await resolveOrderId(orderId);
  if (!id) return { tableId: null, orderIds: [], orderNumbers: [], orders: [] };

  const { data: current, error: curErr } = await supabase
    .from(config.supabase.orderTable)
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
    .from(config.supabase.orderTable)
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
export async function fetchTableOrderNumbers(
  tableNumber: string,
  outletId: string,
): Promise<number[] | null> {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase is not configured.');

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
    .from(config.supabase.orderTable)
    .select('order_number, status, payment_details')
    .eq('table_id', tableId)
    .neq('status', 'cancelled');
  if (error) throw new Error(error.message);

  return ((rows as Record<string, unknown>[] | null) ?? [])
    .filter((r) => !(r.status === 'completed' && r.payment_details != null))
    .map((r) => Number(r.order_number));
}

export async function closeOrderAndFreeTable(orderId: string): Promise<void> {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const id = await resolveOrderId(orderId);
  if (!id) return;

  const { error } = await supabase
    .from(config.supabase.orderTable)
    .update({ status: 'settled', settled_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);

  // Free the table if the order carries a table_id. Non-fatal on failure.
  const { data: ord } = await supabase
    .from(config.supabase.orderTable)
    .select('table_id')
    .eq('id', id)
    .single();
  const tableId = (ord as Record<string, unknown> | null)?.table_id;
  if (tableId != null) {
    await supabase.from('tables').update({ state: 'open' }).eq('id', tableId);
  }
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
export async function fetchOrdersByNumbers(
  orderNumbers: number[],
  outletId: string,
): Promise<FoodOrder[]> {
  if (orderNumbers.length === 0) return [];
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase is not configured.');

  const { data, error } = await supabase
    .from(config.supabase.orderTable)
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
export async function fetchAggregatedItemsForOrders(orderIds: string[]): Promise<OrderItem[]> {
  if (orderIds.length === 0) return [];
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase is not configured.');

  const { data, error } = await supabase
    .from(ITEMS_TABLE_NAME)
    .select('*')
    .in('order_id', orderIds)
    .eq('is_deleted', false);
  if (error) throw new Error(error.message);

  const rows = (data as Record<string, unknown>[] | null)?.map(mapItem) ?? [];
  const merged = new Map<string, OrderItem>();
  for (const item of rows) {
    const key = item.menuItemId ?? `name:${item.name}`;
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      merged.set(key, { ...item });
    }
  }
  return Array.from(merged.values());
}

/**
 * Marks every order in `orderIds` completed (settled_at stamped). Deliberately
 * does NOT free the table — that only happens once payment is recorded for
 * the whole batch via save_order_payment() (db/functions.sql), triggered
 * from the Table Dashboard's Save button. This mirrors complete_order()'s
 * table-batch model but runs over the anon key (no user session) since this
 * is the Android settle-print path.
 */
export async function markOrdersCompleted(orderIds: string[]): Promise<void> {
  if (orderIds.length === 0) return;
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase is not configured.');

  const { error } = await supabase
    .from(config.supabase.orderTable)
    .update({ status: 'completed', settled_at: new Date().toISOString() })
    .in('id', orderIds);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Sales report data access.
//
// These RPCs resolve outlet + role from auth.uid() inside Postgres, so they
// MUST be called on this module's session-bearing client — the anon client
// in supabaseClient.ts has no signed-in user and auth.uid() there is null,
// which the RPCs treat as "no access" (empty result), not an error.
// ---------------------------------------------------------------------------

/**
 * Settled orders for the signed-in user's outlet, aggregated by day or
 * month — one row per bucket, never per order. Empty array if not signed
 * in, no outlet assigned, or the role isn't manager/owner/admin — the RPC
 * enforces this server-side; the caller doesn't need to check separately.
 */
export async function fetchSalesReport(
  from: string,
  to: string,
  bucket: ReportBucket = 'day',
): Promise<SalesReportRow[]> {
  const supabase = getAuthedClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.rpc('get_sales_report_uid', {
    p_from: from,
    p_to: to,
    p_bucket: bucket,
  });
  if (error) throw new Error(error.message);

  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    date: String(row.bucket_date ?? ''),
    orderCount: Number(row.order_count ?? 0),
    taxTotal: Number(row.tax_total ?? 0),
    netTotal: Number(row.net_total ?? 0),
    avgOrderValue: Number(row.avg_order_value ?? 0),
  }));
}

/**
 * Top-selling items (by quantity sold) for the signed-in user's outlet, in
 * the given date range. Same access rules as fetchSalesReport.
 */
export async function fetchTopItems(from: string, to: string, limit = 10): Promise<TopItemRow[]> {
  const supabase = getAuthedClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.rpc('get_top_items', {
    p_from: from,
    p_to: to,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);

  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    menuItemId: String(row.menu_item_id ?? ''),
    name: String(row.name ?? 'Item'),
    quantitySold: Number(row.quantity_sold ?? 0),
    revenue: Number(row.revenue ?? 0),
  }));
}

/** Range totals per order type ('dine-in' | 'pickup' | 'delivery') — the summary stat cards. */
export async function fetchSalesByOrderType(
  from: string,
  to: string,
): Promise<SalesByOrderTypeRow[]> {
  if (!isConfigured()) throw new Error('Supabase is not configured.');
  const supabase = getAuthedClient();

  const { data, error } = await supabase.rpc('get_sales_by_order_type', {
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(error.message);

  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    orderType: String(row.order_type ?? ''),
    orderCount: Number(row.order_count ?? 0),
  }));
}

/** Per-bucket order-type counts, pre-pivoted server-side — the grouped bar chart. */
export async function fetchSalesByTypeBucketed(
  from: string,
  to: string,
  bucket: ReportBucket = 'day',
): Promise<SalesByTypeBucketRow[]> {
  if (!isConfigured()) throw new Error('Supabase is not configured.');
  const supabase = getAuthedClient();

  const { data, error } = await supabase.rpc('get_sales_by_type_bucketed', {
    p_from: from,
    p_to: to,
    p_bucket: bucket,
  });
  if (error) throw new Error(error.message);

  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    date: String(row.bucket_date ?? ''),
    dineInCount: Number(row.dine_in_count ?? 0),
    pickupCount: Number(row.pickup_count ?? 0),
    deliveryCount: Number(row.delivery_count ?? 0),
  }));
}
