import { db, offline } from './data';
import { createSwrCache } from './swrCache';
import { config } from './config';
import { getMyAccess } from './accessManager';
import { orderManager } from './orderManager';
import { printQueue } from './printQueueManager';
import { listManagedTables, saveManagedTable } from './tablesManager';
import { tablesFromCards, toApiTables } from './phoneTables';
import { ApiMyOrder, DINE_IN_ORDER_TYPE, PICK_UP_ORDER_TYPE, PRINT_KOT_ONLY, type ApiTable, type PhoneKotSettings, type RemoteOrderRequest, type RemoteOrderResult } from '../shared/types';
import { BadRemoteOrder, NewTableRequest } from './remoteOrderValidation';
import { alertNewPhoneOrder } from './desktopAlerts';

export { BadRemoteOrder, validateNewTable, validateRemoteOrder } from './remoteOrderValidation';

/**
 * remoteOrderManager.ts: what phones may do through the desktop app.
 * Phones never talk to the database. They read the tables here, and send orders
 * here; the desktop places them (as the phone's user) and prints the kitchen
 * ticket itself.
 */

/**
 * One database call when the bill list carries each table's Tables-page status
 * and active flag (db/migrations/table_bills_floor.sql, 2026-11-27); else the
 * older two reads (tables list, which is two round trips, and the bill list).
 * Both give the same answer.
 */
let billsCarryTableFields: boolean | null = null; // learnt from the first read

/** Table id -> number from the last tables read, so a new-order alert can name the table without a database call. */
const tableNumbers = new Map<string, string>();

async function loadTables(): Promise<ApiTable[]> {
  const tables = await readTables();
  tableNumbers.clear();
  for (const t of tables) tableNumbers.set(t.tableId, t.tableNumber);
  return tables;
}

async function readTables(): Promise<ApiTable[]> {
  // Older database already seen: both reads side by side, as before.
  const managedEarly = billsCarryTableFields === false ? listManagedTables() : null;
  const cards = await db.tables.listCards();
  if (cards.length > 0) billsCarryTableFields = cards[0].managedStatus !== undefined;
  if (billsCarryTableFields) return tablesFromCards(cards);
  const managed = await (managedEarly ?? listManagedTables());
  return toApiTables(
    managed.map((m) => ({ tableId: m.tableId, tableNumber: m.tableNumber, floor: m.floor, capacity: m.capacity, status: m.status, isActive: m.isActive })),
    cards,
  );
}

/**
 * The phones' tables list (docs/API_CACHE.md). Fresh for 2 seconds, so many
 * phones polling cost one database call. Up to 10 seconds old it is answered at
 * once while one refresh runs in the background (not while offline: then every
 * call waits and sees the real error). Any order or table change, on this PC at
 * once and from other PCs through live updates, drops it.
 */
export const TABLES_FRESH_MS = 2000;
export const TABLES_STALE_MS = 10_000;
const tablesCache = createSwrCache<ApiTable[]>({
  load: loadTables,
  freshMs: TABLES_FRESH_MS,
  staleMs: TABLES_STALE_MS,
  allowStale: () => !offline.monitor.isOffline(),
  key: () => config.outletId,
  onBackgroundError: (err:any) => console.warn('[api] tables refresh failed:', err instanceof Error ? err.message : err),
});

/** Drops the tables cache so the next GET /api/tables reads fresh data (live updates, local writes). */
export function invalidateTablesForPhones(): void {
  tablesCache.invalidate(); // a read started before the change is not kept either
}

/** Tables of this outlet with status and details, through the cache above. */
export function getTablesForPhones(): Promise<ApiTable[]> {
  return tablesCache.get();
}

/**
 * Adds a table for the phone's user (POST /api/tables) through the Tables page's
 * own save (saveManagedTable), passing the phone's user id: the database checks
 * that user's tables.manage and outlet, and records them as the creator. Returns
 * the table as GET /api/tables/{tableId} would.
 */
export async function addTableForPhone(req: NewTableRequest, userId: string): Promise<ApiTable> {
  if (!userId) throw new BadRemoteOrder('This device is not tied to a user. Pair it again.');
  const tableId = await saveManagedTable(
    { tableNumber: req.tableNumber, floor: req.floor ?? '', capacity: req.capacity, status: 'available' },
    userId,
  );
  invalidateTablesForPhones(); // a new table
  const table = (await getTablesForPhones()).find((t) => t.tableId === tableId);
  if (!table) throw new Error('The table was saved but could not be read back.');
  return table;
}

/** The unsettled orders this waiter placed. Not cached: the phone wants them live. */
export async function getMyOrders(waiterId: string): Promise<ApiMyOrder[]> {
  return db.remoteOrders.listMyOrders(waiterId);
}

/** Marks one item of the waiter's own open order as served. */
export async function markItemServed(waiterId: string, orderId: string, itemId: string) {
  return db.remoteOrders.markItemServed({ waiterId, orderId, itemId });
}

const KOT_TTL_MS = 30_000;
let kotCache: { at: number; value: PhoneKotSettings } | null = null;

/** Overdue thresholds and kitchen steps for phones. Cached for 30 seconds: they change rarely. */
export async function getKotSettingsForPhones(waiterId: string): Promise<PhoneKotSettings> {
  if (kotCache && Date.now() - kotCache.at < KOT_TTL_MS) return { ...kotCache.value, serverTime: new Date().toISOString() };
  const value = await db.remoteOrders.getKotSettings(waiterId);
  kotCache = { at: Date.now(), value };
  return value;
}

export async function getPhoneConfig(): Promise<{ currencyCode: string; locale: string; taxLabel: string; timezone: string }> {
  const org = (await getMyAccess())?.org;
  return {
    currencyCode: org?.currencyCode ?? 'INR',
    locale: org?.locale ?? 'en-IN',
    taxLabel: org?.taxLabel ?? 'Tax',
    timezone: org?.timezone ?? 'Asia/Kolkata',
  };
}

/**
 * Places the order as the phone's user, then prints the kitchen ticket in the
 * background. The order is saved before the reply; if the printer is busy or
 * off, the ticket is retried by the KOT reconciliation job and shows on the
 * desktop, so the phone does not wait for the printer.
 */
export async function placeRemoteOrder(
  req: RemoteOrderRequest,
  userId: string,
  deviceName: string,
  deviceId: string,
): Promise<RemoteOrderResult> {
  if (!userId) throw new BadRemoteOrder('This device is not tied to a user. Pair it again.');
  const result = await db.remoteOrders.placeOrderAs({
    waiterId: userId,
    orderType: req.orderType === DINE_IN_ORDER_TYPE ? DINE_IN_ORDER_TYPE : PICK_UP_ORDER_TYPE,
    tableId: req.orderType === DINE_IN_ORDER_TYPE ? (req.tableId ?? null) : null,
    outletId: config.outletId,
    items: req.items,
    customerName: req.customerName,
    customerPhone: req.customerPhone,
    notes: req.notes,
    deviceName,
    deviceId,
    clientRequestId: req.clientRequestId,
  });
  invalidateTablesForPhones(); // the table just changed

  if (!result.duplicate) {
    // Desktop alert (docs/DESKTOP_ALERTS.md): no database call, the table number comes from the last tables read.
    alertNewPhoneOrder({
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      tableNumber: req.orderType === DINE_IN_ORDER_TYPE && req.tableId ? (tableNumbers.get(req.tableId) ?? null) : null,
      orderType: req.orderType === DINE_IN_ORDER_TYPE ? DINE_IN_ORDER_TYPE : PICK_UP_ORDER_TYPE,
      itemCount: req.items.reduce((n, i) => n + (Number(i.quantity) || 0), 0),
      deviceId,
      deviceName,
    });
  }

  if (config.outletId) {
    printQueue
      .enqueue(() => orderManager.handleIncoming(String(result.orderId), PRINT_KOT_ONLY))
      .then((r) => {
        if (!r.success) console.warn(`[remote] KOT for order ${result.orderNumber} not printed: ${r.message}`);
      })
      .catch((err) => console.error('[remote] KOT print failed:', err instanceof Error ? err.message : err));
  }
  return result;
}
