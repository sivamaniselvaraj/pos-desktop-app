import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config, isConfigured } from './config';
import type { FoodOrder, HeaderConfig, OrderItem, OrderType, OutletInfo } from '../shared/types';

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
    restaurantName: row.restaurantName ? String(row.restaurantName ?? ''): undefined,
    headerText: row.headerText ? String(row.headerText ?? 'Restaurant'): undefined,
    footerText: row.footerText ? String(row.footerText) : undefined,
    containerChargePercent: row.containerChargePercent ? String(row.containerChargePercent) : undefined,
  };
}

// Maps a raw DB row (snake_case) into our camelCase FoodOrder.
function mapRow(row: Record<string, unknown>): FoodOrder {
  const items = (row.items as OrderItem[]) ?? [];
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
    orderType: (row.order_type as OrderType) ?? 'pickup',
    specialNotes: row.special_notes ? String(row.special_notes) : undefined,
    createdAt: String(row.created_at ?? new Date().toISOString()),
    headerConfig: headerConfigRaw ? mapHeaderConfig(headerConfigRaw) : undefined,
  };
}

export async function fetchOrderById(orderId: string): Promise<FoodOrder | null> {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.');

  const { data, error } = await supabase.rpc('get_order_with_items', {p_order_id: orderId})
  
   
  if (error) {
    if (error.code === 'PGRST116') return null; // no rows
    throw new Error(error.message);
  }
  return data ? mapRow(data as Record<string, unknown>) : null;
}

export async function updatePrinterSettings(outletId: string): Promise<FoodOrder | null> {
  return null;
}

export async function removePrinterSettings(outletId: string, key: string): Promise<FoodOrder | null> {
  return null;
}
export async function loadSettings(outletId: string): Promise<FoodOrder | null> {
  return null;
}

export async function isDatabaseReachable(): Promise<boolean> {
  const supabase = getClient();
  if (!supabase) return false;
  const { error } = await supabase.from(config.supabase.table).select('id').limit(1);
  return !error;
}

export async function fetchOutletById(outletId: string): Promise<OutletInfo | null> {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.');

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
    .from(config.supabase.table)
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

  const { data, error } = await supabase.rpc('get_pending_kot_items', {p_order_id: orderId})
  if (error) throw new Error(error.message);
  return (data as Record<string, unknown>[] | null)?.map(mapItem) ?? [];
}

/**
 * KOT write: stamp exactly the given item rows as sent to the kitchen.
 * Called AFTER a successful KOT print so a failed print doesn't lose the delta.
 */
export async function markItemsKotPrinted(itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase is not configured.');

  const { error } = await supabase
    .from(ITEMS_TABLE_NAME)
    .update({ kot_printed: true, kot_printed_at: new Date().toISOString() })
    .in('id', itemIds);
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
    .eq('order_id', id);
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
 * Settle close: mark the order settled and free the table. Best-effort table
 * reset — table linkage may not exist yet (see #4); safe to no-op if absent.
 */
export async function closeOrderAndFreeTable(orderId: string): Promise<void> {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase is not configured.');
  const id = await resolveOrderId(orderId);
  if (!id) return;

  const { error } = await supabase
    .from(config.supabase.table)
    .update({ status: 'settled', settled_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);

  // Free the table if the order carries a table_id. Non-fatal on failure.
  const { data: ord } = await supabase
    .from(config.supabase.table)
    .select('table_id')
    .eq('id', id)
    .single();
  const tableId = (ord as Record<string, unknown> | null)?.table_id;
  if (tableId != null) {
    await supabase.from('tables').update({ state: 'open' }).eq('id', tableId);
  }
}