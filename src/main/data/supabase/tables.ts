import { getAuthedClient } from './sessionClient';
import { deriveCardStatus } from '../helpers';
import type { TableRepository, TableValues } from '../ports';
import type { ManagedTable, ManagedTableStatus, TableCard } from '../../../shared/types';

// How this database stores a table's manual status.
const MANAGED_STATUSES: ManagedTableStatus[] = ['available', 'occupied', 'reserved', 'cleaning'];

function toManagedStatus(value: unknown): ManagedTableStatus {
  const v = String(value ?? '');
  return (MANAGED_STATUSES as string[]).includes(v) ? (v as ManagedTableStatus) : 'available';
}

const DB_STATE: Record<ManagedTableStatus, string> = {
  available: 'open', // 'open' is what settle/cancel already write for a free table
  occupied: 'occupied',
  reserved: 'reserved',
  cleaning: 'cleaning',
};

function fromDbState(state: unknown): ManagedTableStatus {
  return toManagedStatus(state === 'open' ? 'available' : state);
}

function friendlyDbError(error: { code?: string; message: string }, fallback: string): Error {
  if (error.code === '23505') return new Error('A table with that number already exists');
  if (error.code === '23503') {
    return new Error('This table is referenced by existing orders and cannot be deleted');
  }
  if (error.code === '23514') return new Error('Capacity must be a positive number');
  return new Error(error.message || fallback);
}

function toRow(values: TableValues) {
  return {
    table_number: values.tableNumber,
    floor: values.floorArea,
    capacity: values.capacity,
    state: DB_STATE[values.status],
  };
}

/**
 * Plain table queries guarded by RLS ("staff manage own outlet tables" in
 * db/schema.sql). The explicit outlet filters are for correctness; RLS is the
 * security boundary.
 */
async function liveOrderCounts(outletId: string): Promise<Map<string, number>> {
  // Via a function that returns table ids only, so staff (who can't read
  // orders) get occupancy too.
  const { data, error } = await getAuthedClient().rpc('live_order_table_ids', { p_outlet_id: outletId });
  if (error) throw new Error(error.message);
  const counts = new Map<string, number>();
  for (const r of (data ?? []) as { table_id: string; live_orders: number }[]) {
    counts.set(String(r.table_id), Number(r.live_orders));
  }
  return counts;
}

export const tables: TableRepository = {
  async listCards(): Promise<TableCard[]> {
    const { data, error } = await getAuthedClient().rpc('list_tables_for_outlet');
    if (error) throw new Error(error.message);
    return ((data ?? []) as Record<string, unknown>[]).map((row) => {
      const orderIds = (row.order_ids as string[] | null)?.map((id) => String(id)) ?? undefined;
      const orderNumbers = (row.order_numbers as number[] | null)?.map((n) => Number(n)) ?? undefined;
      return {
        tableId: String(row.table_id ?? ''),
        tableNumber: String(row.table_number ?? ''),
        tableState: String(row.table_state ?? ''),
        //manualStatus: toManagedStatus(row.table_state === 'open' ? 'available' : row.table_state),
        invoiceNumber: row.invoice_number ? String(row.invoice_number) : undefined,
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
  },

  async savePayment(payload) {
    const { error } = await getAuthedClient().rpc('save_order_payment', {
      p_order_id: payload.orderId,
      p_method: payload.method,
      p_cash_amount: payload.cashAmount ?? null,
      p_card_amount: payload.cardAmount ?? null,
      p_upi_amount: payload.upiAmount ?? null,
    });
    if (error) throw new Error(error.message);
  },

  async listManaged(outletId): Promise<ManagedTable[]> {
    const { data, error } = await getAuthedClient()
      .from('tables')
      .select('id, table_number, floor_area, capacity, status')
      .eq('outlet_id', outletId);
    if (error) throw new Error(error.message);
    const liveCount = await liveOrderCounts(outletId);
    return ((data ?? []) as Record<string, unknown>[]).map((row): ManagedTable => {
      const tableId = String(row.id);
      const active = liveCount.get(tableId) ?? 0;
      const status = fromDbState(row.status);
      return {
        tableId,
        tableNumber: String(row.table_number ?? ''),
        floor: row.floor ? String(row.floor_area) : '',
        capacity: row.capacity != null ? Number(row.capacity) : null,
        status,
        effectiveStatus: active > 0 ? 'occupied' : status,
        activeOrderCount: active,
      };
    });
  },

  async listTableNumbers(outletId) {
    const { data, error } = await getAuthedClient().from('tables').select('id, table_number').eq('outlet_id', outletId);
    if (error) throw new Error(error.message);
    return ((data ?? []) as { id: string; table_number: unknown }[]).map((t) => ({
      id: String(t.id),
      tableNumber: String(t.table_number ?? ''),
    }));
  },

  async insert(outletId, values) {
    const { error } = await getAuthedClient().from('tables').insert({ ...toRow(values), outlet_id: outletId });
    if (error) throw friendlyDbError(error, 'Failed to add table');
  },

  // RLS filters a row you may not touch out silently, so ask for the row back
  // and treat "nothing updated" as a failure.
  async update(outletId, tableId, values) {
    const { data, error } = await getAuthedClient()
      .from('tables')
      .update(toRow(values))
      .eq('id', tableId)
      .eq('outlet_id', outletId)
      .select('id');
    if (error) throw friendlyDbError(error, 'Failed to update table');
    if (!data || data.length === 0) throw new Error('Table not found in this outlet');
  },

  async countOrdersForTable(tableId) {
    const { count, error } = await getAuthedClient()
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('table_id', tableId);
    if (error) throw new Error(error.message);
    return count ?? 0;
  },

  async remove(outletId, tableId) {
    const { data, error } = await getAuthedClient()
      .from('tables')
      .delete()
      .eq('id', tableId)
      .eq('outlet_id', outletId)
      .select('id');
    if (error) throw friendlyDbError(error, 'Failed to delete table');
    if (!data || data.length === 0) throw new Error('Table not found in this outlet');
  },

  async getStatus(outletId, tableId) {
    const { data, error } = await getAuthedClient()
      .from('tables')
      .select('state')
      .eq('id', tableId)
      .eq('outlet_id', outletId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? fromDbState(data.state) : null;
  },

  async liveOrderCount(outletId, tableId) {
    return (await liveOrderCounts(outletId)).get(tableId) ?? 0;
  },

  async setStatus(outletId, tableId, status) {
    const { data, error } = await getAuthedClient()
      .from('tables')
      .update({ state: DB_STATE[status] })
      .eq('id', tableId)
      .eq('outlet_id', outletId)
      .select('id');
    if (error) throw friendlyDbError(error, 'Failed to update table status');
    if (!data || data.length === 0) throw new Error('Table not found in this outlet');
  },

  async getStatusById(tableId) {
    const { data, error } = await getAuthedClient().from('tables').select('state').eq('id', tableId).single();
    if (error) throw new Error(error.message);
    return data ? fromDbState(data.state) : null;
  },
};
