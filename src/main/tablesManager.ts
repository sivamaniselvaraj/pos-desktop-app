import { getAuthedClient } from './supabaseAuthClient';
import { config } from './config';
import type { TableCard, TableCardStatus, SavePaymentPayload } from '../shared/types';


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

  return ((data ?? []) as Record<string, unknown>[]).map((row) => {
    const orderIds = (row.order_ids as string[] | null)?.map((id) => String(id)) ?? undefined;
    const orderNumbers = (row.order_numbers as number[] | null)?.map((n) => Number(n)) ?? undefined;
    return {
    tableId: String(row.table_id ?? ''),
    tableNumber: String(row.table_number ?? ''),
    tableState: String(row.table_state ?? ''),
    orderIds,
    orderNumbers,
    orderId: orderIds && orderIds.length > 0 ? orderIds[0] : undefined,
    orderStatus: row.order_status ? String(row.order_status) : undefined,
    orderCreatedAt: row.order_created_at ? String(row.order_created_at) : undefined,
    orderTotalAmount: row.order_total_amount != null ? Number(row.order_total_amount) : undefined,
    cardStatus: deriveCardStatus(row.order_status ? String(row.order_status) : undefined),
    paymentRecorded: row.payment_recorded === true,
  };
});
}

export async function createTable(tableNumber: string): Promise<void> {
  const supabase = getAuthedClient();
  const { error } = await supabase.rpc('create_table', { p_table_number: tableNumber });
  if (error) throw new Error(error.message);
}
