import { getAuthedClient } from './supabaseAuthClient';
import { config } from './config';
import type { TableCard, TableCardStatus } from '../shared/types';


const TABLES_NAME = 'tables';

/**
 * tablesManager.ts
 * ---------------------------------------------------------------------------
 * Backs the Dashboard's table-cards view. Only listing and creating tables
 * live here — printing, viewing items, and editing an order all reuse the
 * exact same functions ordersListManager.ts already has (reprintOrder,
 * getOrderDetail, getOrderActivityLog, editOrderItem, deleteOrderItem) via
 * IPC, rather than duplicating that logic for a second entry point.
 * ---------------------------------------------------------------------------
 */

function deriveCardStatus(orderStatus: string | undefined): TableCardStatus {
  if (!orderStatus || orderStatus === 'cancelled') return 'available';
  if (orderStatus === 'completed') return 'settled';
  return 'active'; // 'open'
}

export async function listTables(): Promise<TableCard[]> {
  const supabase = getAuthedClient();
  const { data, error } = await supabase.rpc('list_tables_for_outlet');

  //const { data, error } = await supabase.from(TABLES_NAME).select('*').eq('outlet_id', config.outletId);
  if (error) throw new Error(error.message);

  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    tableId: String(row.table_id ?? ''),
    tableNumber: String(row.table_number ?? ''),
    tableState: String(row.table_state ?? ''),
    orderId: row.order_id ? String(row.order_id) : undefined,
    orderStatus: row.order_status ? String(row.order_status) : undefined,
    orderCreatedAt: row.order_created_at ? String(row.order_created_at) : undefined,
    orderTotalAmount: row.order_total_amount != null ? Number(row.order_total_amount) : undefined,
    cardStatus: deriveCardStatus(row.order_status ? String(row.order_status) : undefined),
  }));
}

export async function createTable(tableNumber: string): Promise<void> {
  const supabase = getAuthedClient();
  const { error } = await supabase.rpc('create_table', { p_table_number: tableNumber });
  if (error) throw new Error(error.message);
}
