import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config, isConfigured } from './config';
import type { FoodOrder, OrderItem, OrderType } from '../shared/types';

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (!isConfigured()) return null;
  if (!client) {
    client = createClient(config.supabase.url, config.supabase.anonKey);
  }
  return client;
}

// Maps a raw DB row (snake_case) into our camelCase FoodOrder.
function mapRow(row: Record<string, unknown>): FoodOrder {
  const items = (row.items as OrderItem[]) ?? [];
  return {
    id: String(row.id ?? ''),
    orderId: String(row.id ?? ''),
    orderNumber: Number(row.order_number ?? 0),
    tableNumber: Number(row.table_number ?? 0),
    customerName: String(row.customer_name ?? 'Unknown'),
    customerPhone: row.customer_phone ? String(row.customer_phone) : undefined,
    deliveryAddress: row.delivery_address ? String(row.delivery_address) : undefined,
    items,
    subtotal: Number(row.subtotal ?? 0),
    tax: Number(row.tax_amount ?? 0),
    total: Number(row.total_amount ?? 0),
    orderType: (row.order_type as OrderType) ?? 'pickup',
    specialNotes: row.special_notes ? String(row.special_notes) : undefined,
    createdAt: String(row.created_at ?? new Date().toISOString()),
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

export async function isDatabaseReachable(): Promise<boolean> {
  const supabase = getClient();
  if (!supabase) return false;
  const { error } = await supabase.from(config.supabase.table).select('id').limit(1);
  return !error;
}
