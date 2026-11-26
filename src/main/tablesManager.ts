import { db, TableValues } from './data';
import { config } from './config';
import type { 
  TableCard, 
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
    throw new Error('No outlet is set for this machine. Enter the outlet id on the setup screen.');
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
  const rows = await db.tables.listManaged(requireOutletId());
  return rows.sort((a, b) => compareTableNumbers(a.tableNumber, b.tableNumber));
}

/**
 * Adds (no tableId) or edits a table. actingUserId: the user who adds it when it
 * is not the signed-in user (a paired phone, POST /api/tables); the database checks
 * that user's permission and records them as the creator. Returns the new table's
 * id when one was added, else null.
 */
export async function saveManagedTable(payload: SaveManagedTablePayload, actingUserId?: string): Promise<string | null> {
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

  const values: TableValues = {
    tableNumber: tableNumber,
    floorArea: payload.floor.trim() || null,
    capacity: payload.capacity,
    status: payload.status,
    createdBy: actingUserId,
    updatedBy: actingUserId
  };

  if (!payload.tableId) return db.tables.insert(outletId, values, actingUserId);
  if (actingUserId) throw new Error('Only a new table can be saved for another user');
  await db.tables.update(outletId, payload.tableId, values);
  return null;
}

/**
 * Tables are never deleted (docs/TABLE_ACTIVE.md). A table that is not used any more is
 * marked inactive: it stays on the Tables page with its number and past orders, but is not
 * offered on the Dashboard, New order or phones, and takes no new orders. Making a table
 * inactive is refused while it has an open order or a bill waiting for payment (the
 * database checks again in set_table_active).
 */
export async function setManagedTableActive(tableId: string, active: boolean): Promise<void> {
  const outletId = requireOutletId();
  if (!active && (await db.tables.liveOrderCount(outletId, tableId)) > 0) {
    throw new Error("This table has an open order or a bill waiting for payment, so it can't be made inactive.");
  }
  await db.tables.setActive(outletId, tableId, active);
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
