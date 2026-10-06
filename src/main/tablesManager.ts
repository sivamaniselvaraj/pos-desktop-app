import { db } from './data';
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
 * Backs the Dashboard's table-cards view and the Tables management page.
 * Validation and business rules live here; storage is behind db.tables.
 * Printing, viewing items, and editing an order reuse the functions
 * ordersListManager.ts already has, via IPC.
 * ---------------------------------------------------------------------------
 */

function deriveCardStatus(orderStatus: string | undefined): TableCardStatus {
  if (!orderStatus || orderStatus === 'cancelled') return 'available';
  if (orderStatus === 'completed') return 'settled';
  return 'active'; // 'open'
}

export function listTables(): Promise<TableCard[]> {
  return db.tables.listCards();
}

export function savePayment(payload: SavePaymentPayload): Promise<void> {
    return db.tables.savePayment(payload);
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

const DB_STATE: Record<ManagedTableStatus, string> = {
  available: 'available', // 'available' is what settle/cancel already write for a free table
  occupied: 'occupied',
  reserved: 'reserved',
  cleaning: 'cleaning',
};


/** "1, 2, 2A, 10": leading number first, then the full text. */
function compareTableNumbers(a: string, b: string): number {
  const na = /^\d{1,9}/.exec(a);
  const nb = /^\d{1,9}/.exec(b);
  if (na && nb && Number(na[0]) !== Number(nb[0])) return Number(na[0]) - Number(nb[0]);
  if (na && !nb) return -1;
  if (!na && nb) return 1;
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
}

export async function listManagedTables(): Promise<ManagedTable[]> {
  const  outletId = requireOutletId();
  const rows = await db.tables.listManaged(outletId);
  return rows.sort((a, b) => compareTableNumbers(a.tableNumber, b.tableNumber));
}

export async function saveManagedTable(payload: SaveManagedTablePayload): Promise<void> {
  const outletId = requireOutletId();

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
    const existing = await db.tables.listTableNumbers(outletId);

  const clash = existing.some(
    (t) =>
      String(t.tableNumber ?? '').toLowerCase() === tableNumber.toLowerCase() &&
      t.id !== payload.tableId,
  );
  if (clash) throw new Error(`Table "${tableNumber}" already exists in this outlet`);

  const values = {
    tableNumber: tableNumber,
    floorArea: payload.floor.trim() || null,
    capacity: payload.capacity,
    status: payload.status,
  };

  if (!payload.tableId) {
    await db.tables.insert(outletId, values);
    return;
  }
 await db.tables.update(outletId, payload.tableId, values);
}

export async function deleteManagedTable(tableId: string): Promise<void> {
  const outletId = requireOutletId();

  // Never delete a table that has carried an order: it would orphan (or, with
  // a foreign key, be blocked by) that order's history and the reports.
  if ((await db.tables.countOrdersForTable(tableId)) > 0) {
    throw new Error(
      'This table has order history and cannot be deleted. Set its status to cleaning/reserved instead, or rename it.',
    );
  }
  await db.tables.remove(outletId, tableId);
}

/**
 * Quick toggle from the Tables list — available <-> occupied only, for every
 * role (staff/waiters included). Anything else (reserved, cleaning) is set via
 * the Edit form by a manager. Refused while the table has a live order
 * (cancelled orders don't count). The database enforces the staff rule again.
 */
export async function setManagedTableStatus(
  tableId: string,
  status: ManagedTableStatus,
): Promise<void> {
  const outletId = requireOutletId();
  if (status !== 'available' && status !== 'occupied') {
    throw new Error('The quick toggle only switches between available and occupied.');
  }

  const current = await db.tables.getStatus(outletId, tableId);
  if (!current) throw new Error('Table not found in this outlet');
  if (current !== 'available' && current !== 'occupied') {
    throw new Error(`This table is ${current}; ask a manager to change it from Edit.`);
  }

  if ((await db.tables.liveOrderCount(outletId, tableId)) > 0) {
    throw new Error("This table has a live order, so its status can't be changed manually.");
  }

  await db.tables.setStatus(outletId, tableId, status);
}
