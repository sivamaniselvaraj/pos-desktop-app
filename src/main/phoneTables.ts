import type { ApiTable, ManagedTableStatus, TableCard } from '../shared/types';

/**
 * phoneTables.ts: the phones' table list (GET /api/tables) built from the
 * database rows. No database or Electron import, so it is tested in plain Node
 * (tests/api/phoneTables.test.ts). Used by remoteOrderManager.ts; the table
 * number order is shared with the Tables page (tablesManager.ts).
 */

/** "1, 2, 2A, 10": leading number first, then the full text. */
export function compareTableNumbers(a: string, b: string): number {
  const na = /^\d{1,9}/.exec(a);
  const nb = /^\d{1,9}/.exec(b);
  if (na && nb && Number(na[0]) !== Number(nb[0])) return Number(na[0]) - Number(nb[0]);
  if (na && !nb) return -1;
  if (!na && nb) return 1;
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
}

export type PhoneTableRow = { tableId: string; tableNumber: string; floor: string; capacity: number | null; status: ManagedTableStatus; isActive: boolean };

/** The tables list as listManagedTables would give it (sorted, one row per table), from the bill rows. */
export function tablesFromCards(cards: TableCard[]): ApiTable[] {
  const byTable = new Map<string, PhoneTableRow>();
  for (const c of cards) {
    if (byTable.has(c.tableId)) continue;
    byTable.set(c.tableId, {
      tableId: c.tableId,
      tableNumber: c.tableNumber,
      floor: c.floor ?? '',
      capacity: c.capacity ?? null,
      status: c.managedStatus ?? 'available',
      isActive: c.isActive !== false,
    });
  }
  const rows = [...byTable.values()].sort((a, b) => compareTableNumbers(a.tableNumber, b.tableNumber));
  return toApiTables(rows, cards);
}

export function toApiTables(managed: PhoneTableRow[], cards: TableCard[]): ApiTable[] {
  // A table can have several bills (docs/TABLE_BILLS.md): at most one running and
  // any number printed and waiting for payment. Phones see only the running bill.
  // A table whose bills are all printed shows as FREE, so a captain can seat the
  // next guests there; the printed bills are paid on the desktop.
  const runningByTable = new Map<string, TableCard>();
  for (const c of cards) if (c.cardStatus === 'active') runningByTable.set(c.tableId, c);
  // Phones only get active tables: orders go only to those (docs/TABLE_ACTIVE.md).
  return managed.filter((m) => m.isActive).map((m): ApiTable => {
    const c = runningByTable.get(m.tableId);
    const ids = c?.orderIds ?? (c?.orderId ? [c.orderId] : []);
    const nums = c?.orderNumbers ?? [];
    const blocked = m.status === 'reserved' || m.status === 'cleaning';
    return {
      tableId: m.tableId,
      tableNumber: m.tableNumber,
      floor: m.floor,
      capacity: m.capacity,
      // Occupied while a bill is running, whatever was set by hand. Otherwise the
      // status set on the Tables page, where "occupied" (also set by unpaid printed
      // bills) reads as available.
      status: c ? 'occupied' : blocked ? m.status : 'available',
      manualStatus: m.status,
      billStatus: c ? 'active' : 'available',
      paymentRecorded: false,
      orders: ids.map((orderId, i) => ({ orderId, orderNumber: nums[i] ?? 0 })),
      invoiceNumber: c?.invoiceNumber ?? null,
      total: c?.orderTotalAmount ?? 0,
      since: c?.orderCreatedAt ?? null,
    };
  });
}
