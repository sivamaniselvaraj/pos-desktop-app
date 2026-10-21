import { db } from './data';
import { config } from './config';
import { getMyAccess } from './accessManager';
import { orderManager } from './orderManager';
import { printQueue } from './printQueue';
import { listManagedTables } from './tablesManager';
import { ApiMyOrder, DINE_IN_ORDER_TYPE, type ApiTable, type PhoneKotSettings, type RemoteOrderRequest, type RemoteOrderResult } from '../shared/types';
import { BadRemoteOrder } from './remoteOrderValidation';

export { BadRemoteOrder, validateRemoteOrder } from './remoteOrderValidation';

/**
 * remoteOrderManager.ts: what phones may do through the desktop app.
 * Phones never talk to the database. They read the tables here, and send orders
 * here; the desktop places them (as the phone's user) and prints the kitchen
 * ticket itself.
 */

const TABLES_TTL_MS = 2000;
let tablesCache: { at: number; value: ApiTable[] } | null = null;
let tablesInflight: Promise<ApiTable[]> | null = null;

async function loadTables(): Promise<ApiTable[]> {
  const [managed, cards] = await Promise.all([listManagedTables(), db.tables.listCards()]);
  const cardById = new Map(cards.map((c) => [c.tableId, c]));
  return managed.map((m): ApiTable => {
    const c = cardById.get(m.tableId);
    const billStatus = c?.cardStatus ?? 'available';
    const ids = c?.orderIds ?? (c?.orderId ? [c.orderId] : []);
    const nums = c?.orderNumbers ?? [];
    return {
      tableId: m.tableId,
      tableNumber: m.tableNumber,
      floor: m.floor,
      capacity: m.capacity,
      // A table with an open order is occupied whatever was set by hand.
      status: billStatus !== 'available' ? 'occupied' : m.effectiveStatus,
      manualStatus: m.status,
      billStatus,
      paymentRecorded: c?.paymentRecorded ?? false,
      orders: ids.map((orderId, i) => ({ orderId, orderNumber: nums[i] ?? 0 })),
      invoiceNumber: c?.invoiceNumber ?? null,
      total: c?.orderTotalAmount ?? 0,
      since: c?.orderCreatedAt ?? null,
    };
  });
}

/** Tables of this outlet with status and details. Cached for 2 seconds so many phones polling cost one database call. */
export async function getTablesForPhones(): Promise<ApiTable[]> {
  if (tablesCache && Date.now() - tablesCache.at < TABLES_TTL_MS) return tablesCache.value;
  if (!tablesInflight) {
    tablesInflight = loadTables()
      .then((v) => {
        tablesCache = { at: Date.now(), value: v };
        return v;
      })
      .finally(() => {
        tablesInflight = null;
      });
  }
  return tablesInflight;
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
export async function getKotSettingsForPhones(): Promise<PhoneKotSettings> {
  if (kotCache && Date.now() - kotCache.at < KOT_TTL_MS) return { ...kotCache.value, serverTime: new Date().toISOString() };
  const value = await db.remoteOrders.getKotSettings();
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
    orderType: req.orderType === DINE_IN_ORDER_TYPE ? DINE_IN_ORDER_TYPE : 'pickup',
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
  tablesCache = null; // the table just changed

  if (config.outletId) {
    printQueue
      .enqueue(() => orderManager.handleIncoming(String(result.orderId), 'kot'))
      .then((r) => {
        if (!r.success) console.warn(`[remote] KOT for order ${result.orderNumber} not printed: ${r.message}`);
      })
      .catch((err) => console.error('[remote] KOT print failed:', err instanceof Error ? err.message : err));
  }
  return result;
}
