import { getAuthedClient } from './supabaseAuthClient';
import { config } from './config';
import type { 
  TableCard, 
  TableCardStatus, 
  SavePaymentPayload, 
  ManagedTable,
  ManagedTableStatus,
  SaveManagedTablePayload, 
} from '../shared/types';


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
}

export async function savePayment(payload: SavePaymentPayload): Promise<void> {
  const supabase = getAuthedClient();
  const { error } = await supabase.rpc('save_order_payment', {
    p_order_id: payload.orderId,
    p_method: payload.method,
    p_cash_amount: payload.cashAmount ?? null,
    p_card_amount: payload.cardAmount ?? null,
    p_upi_amount: payload.upiAmount ?? null,
  });
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Tables management page. Scoped to this machine's outlet (config.outletId);
// the RPCs re-validate that the signed-in user is a manager/owner/admin of it.
// ---------------------------------------------------------------------------
function requireOutletId(): string {
  if (!config.outletId) {
    throw new Error('OUTLET_ID is not configured for this machine — set it in .env.local.');
  }
  return config.outletId;
}

const MANAGED_STATUSES: ManagedTableStatus[] = ['available', 'occupied', 'reserved', 'cleaning'];

function toManagedStatus(value: unknown): ManagedTableStatus {
  const v = String(value ?? '');
  return (MANAGED_STATUSES as string[]).includes(v) ? (v as ManagedTableStatus) : 'available';
}

const DB_STATE: Record<ManagedTableStatus, string> = {
  available: 'available', // 'available' is what settle/cancel already write for a free table
  occupied: 'occupied',
  reserved: 'reserved',
  cleaning: 'cleaning',
};

function fromDbState(state: unknown): ManagedTableStatus {
  return toManagedStatus(state === 'available' ? 'available' : state);
}

/** "1, 2, 2A, 10": leading number first, then the full text. */
function compareTableNumbers(a: string, b: string): number {
  const na = /^\d{1,9}/.exec(a);
  const nb = /^\d{1,9}/.exec(b);
  if (na && nb && Number(na[0]) !== Number(nb[0])) return Number(na[0]) - Number(nb[0]);
  if (na && !nb) return -1;
  if (!na && nb) return 1;
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
}

function friendlyDbError(error: { code?: string; message: string }, fallback: string): Error {
  if (error.code === '23505') return new Error('A table with that number already exists');
  if (error.code === '23503') {
    return new Error('This table is referenced by existing orders and cannot be deleted');
  }
  if (error.code === '23514') return new Error('Capacity must be a positive number');
  return new Error(error.message || fallback);
}

/**
 * Plain table queries guarded by RLS ("staff manage own outlet tables" in
 * db/schema.sql): a signed-in manager/owner/admin can only ever see or touch
 * rows of their own outlet, whatever outlet id the app sends. The explicit
 * outlet filters below are for correctness (this machine's outlet), RLS is
 * the security boundary.
 */
async function fetchLiveOrderCounts(rows: any[]): Promise<Map<string, number>> {
  const supabase = getAuthedClient();
  // Live orders per table (not cancelled, not yet paid) -> "occupied".
  const liveCount = new Map<string, number>();
  const ids = rows.map((r) => String(r.id));
  if (ids.length > 0) {
    const { data: live, error: liveErr } = await supabase
      .from('orders')
      .select('table_id', { count: 'exact' } )
      .in('table_id', ids)
      .neq('status', 'cancelled')
      .is('payment_details', null);
    if (liveErr) throw new Error(liveErr.message);
    for (const o of (live ?? []) as {  table_id: string; live_orders: number }[]) {
      liveCount.set(o.table_id, (liveCount.get(o.table_id) ?? 0) + 1);
    }
  }
  return liveCount;
}

export async function listManagedTables(): Promise<ManagedTable[]> {
  const outletId = requireOutletId();
  const supabase = getAuthedClient();

  const { data, error } = await supabase
    .from('tables')
    .select('id, table_number, floor_area, capacity, status')
    .eq('outlet_id', outletId);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Record<string, unknown>[];

  // Live orders per table (not cancelled, not yet paid) -> "occupied". Via an
  // RPC that returns table ids only, so staff (who can't read orders) get it too.
  const liveCount = await fetchLiveOrderCounts(rows);

  return rows
    .map((row): ManagedTable => {
      const tableId = String(row.id);
      const active = liveCount.get(tableId) ?? 0;
      const status = fromDbState(row.status);
      return {
        tableId,
        tableNumber: String(row.table_number ?? ''),
        floor: row.floor_area ? String(row.floor_area) : '',
        capacity: row.capacity != null ? Number(row.capacity) : null,
        status,
        effectiveStatus: active > 0 ? 'occupied' : status,
        activeOrderCount: active,
      };
    })
    .sort((a, b) => compareTableNumbers(a.tableNumber, b.tableNumber));
}

export async function saveManagedTable(payload: SaveManagedTablePayload): Promise<void> {
  const outletId = requireOutletId();
  const supabase = getAuthedClient();

  const tableNumber = payload.tableNumber.trim();
  if (!tableNumber) throw new Error('Table number is required');
  if (
    payload.capacity !== null &&
    (!Number.isInteger(payload.capacity) || payload.capacity <= 0)
  ) {
    throw new Error('Capacity must be a whole number greater than 0');
  }
  const state = DB_STATE[payload.status];
  if (!state) throw new Error('Invalid status');

  // Case-insensitive uniqueness per outlet ('2a' and '2A' are the same table).
  const { data: existing, error: dupErr } = await supabase
    .from('tables')
    .select('id, table_number')
    .eq('outlet_id', outletId);
  if (dupErr) throw new Error(dupErr.message);
  const clash = ((existing ?? []) as { id: string; table_number: unknown }[]).some(
    (t) =>
      String(t.table_number ?? '').toLowerCase() === tableNumber.toLowerCase() &&
      t.id !== payload.tableId,
  );
  if (clash) throw new Error(`Table "${tableNumber}" already exists in this outlet`);

  const values = {
    table_number: tableNumber,
    floor_area: payload.floor.trim() || null,
    capacity: payload.capacity,
    state,
  };

  if (!payload.tableId) {
    const { error } = await supabase.from('tables').insert({ ...values, outlet_id: outletId });
    if (error) throw friendlyDbError(error, 'Failed to add table');
    return;
  }

  // RLS filters a row you may not touch out silently, so ask for the row back
  // and treat "nothing updated" as a failure.
  const { data, error } = await supabase
    .from('tables')
    .update(values)
    .eq('id', payload.tableId)
    .eq('outlet_id', outletId)
    .select('id');
  if (error) throw friendlyDbError(error, 'Failed to update table');
  if (!data || data.length === 0) throw new Error('Table not found in this outlet');
}

export async function deleteManagedTable(tableId: string): Promise<void> {
  const outletId = requireOutletId();
  const supabase = getAuthedClient();

  // Never delete a table that has carried an order: it would orphan (or, with
  // a foreign key, be blocked by) that order's history and the reports.
  const { count, error: countErr } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('table_id', tableId);
  if (countErr) throw new Error(countErr.message);
  if ((count ?? 0) > 0) {
    throw new Error(
      'This table has order history and cannot be deleted. Set its status to cleaning/reserved instead, or rename it.',
    );
  }

  const { data, error } = await supabase
    .from('tables')
    .delete()
    .eq('id', tableId)
    .eq('outlet_id', outletId)
    .select('id');
  if (error) throw friendlyDbError(error, 'Failed to delete table');
  if (!data || data.length === 0) throw new Error('Table not found in this outlet');
}

/**
 * Quick toggle from the Tables list — available <-> occupied only, for every
 * role (staff/waiters included). Anything else (reserved, cleaning) is set via
 * the Edit form by a manager. Refused while the table has a live order
 * (cancelled orders don't count). Enforced again in the database for staff
 * (enforce_staff_table_update trigger), so this is not the only guard.
 */
export async function setManagedTableStatus(
  tableId: string,
  status: ManagedTableStatus,
): Promise<void> {
  const outletId = requireOutletId();
  const supabase = getAuthedClient();
  if (status !== 'available' && status !== 'occupied') {
    throw new Error('The quick toggle only switches between available and occupied.');
  }

  const { data: current, error: curErr } = await supabase
    .from('tables')
    .select('status, id')
    .eq('id', tableId)
    .eq('outlet_id', outletId)
    .maybeSingle();
  if (curErr) throw new Error(curErr.message);
  if (!current) throw new Error('Table not found in this outlet');
  if (current.status !== 'available' && current.status !== 'occupied') {
    throw new Error(
      `This table is ${fromDbState(current.status)}; ask a manager to change it from Edit.`,
    );
  }

  const live = await fetchLiveOrderCounts([current]);
  if ((live.get(tableId) ?? 0) > 0) {
    throw new Error("This table has a live order, so its status can't be changed manually.");
  }

  const { data, error } = await supabase
    .from('tables')
    .update({ status: DB_STATE[status] })
    .eq('id', tableId)
    .eq('outlet_id', outletId)
    .select('id');
  if (error) throw friendlyDbError(error, 'Failed to update table status');
  if (!data || data.length === 0) throw new Error('Table not found in this outlet');
}
