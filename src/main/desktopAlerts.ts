import { Notification, type BrowserWindow } from 'electron';
import { config } from './config';
import { orderManager } from './orderManager';
import { addOrderWatchListener, publish } from './notificationHub';
import { lateAlerts, type LateMemory } from './desktopAlertCore';
import { where, type OrderWatchSnapshot } from './kotNotifierCore';
import { IpcChannels } from '../shared/ipc';
import type { FoodOrder } from '../shared/types';
import type {
  AlertPush,
  AlertSettings,
  AlertSnapshot,
  DesktopAlert,
  DesktopAlertKind,
} from '../shared/alertTypes';

/**
 * desktopAlerts.ts: alerts on this computer (docs/DESKTOP_ALERTS.md).
 *
 *  - new-order: a waiter's phone placed an order through this PC.
 *  - kot-failed: a kitchen ticket did not print (any path: phone, New order,
 *    the 30 s sweep, Print KOT). Stays open, as a red banner, until that
 *    order's KOT prints or someone dismisses it; the 30 s sweep retrying the
 *    same order does not alert again. The phone that placed the order is told too.
 *  - late: an order reached a waiting-time level after 0 minutes ("Getting
 *    late", "Late"), from the order watch notificationHub already reads.
 *
 * No database calls of its own: it hears orderManager's KOT results, the
 * phone order route and the hub's order watch. Kept in memory only (last 50);
 * the window gets the whole list on every change (IPC ALERTS_CHANGED), plays
 * the sound, and a Windows notification shows when the window is not in front.
 */

const KEEP = 50;

let getWindow: () => BrowserWindow | null = () => null;
let nextId = 1;
let lastReadId = 0;
const alerts: DesktopAlert[] = []; // newest first
const problems = new Map<string, DesktopAlert>(); // open kot-failed, by order id
const lateMemory: LateMemory = new Map();
/** Order id -> the paired phone that placed it (from the order watch and the phone order route). */
const deviceByOrder = new Map<string, string>();
let started = false;

function settings(): AlertSettings {
  return config.alertSettings;
}

function enabled(kind: DesktopAlertKind): boolean {
  const s = settings();
  return kind === 'new-order' ? s.newOrder : kind === 'kot-failed' ? s.kotFailed : s.late;
}

export function getAlertSnapshot(): AlertSnapshot {
  return {
    alerts: alerts.slice(),
    unread: alerts.filter((a) => a.id > lastReadId).length,
    problems: [...problems.values()],
    settings: settings(),
  };
}

function push(fresh?: DesktopAlert): void {
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  const payload: AlertPush = { snapshot: getAlertSnapshot(), fresh };
  win.webContents.send(IpcChannels.ALERTS_CHANGED, payload);
}

/** A Windows notification, only when nobody is looking at the app. Silent: the app plays its own sound. */
function showSystemNotification(a: DesktopAlert): void {
  if (!settings().systemNotification || !Notification.isSupported()) return;
  const win = getWindow();
  if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused()) return;
  try {
    const n = new Notification({ title: a.title, body: a.message, silent: true });
    n.on('click', () => {
      const w = getWindow();
      if (!w || w.isDestroyed()) return;
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
      w.webContents.send(IpcChannels.ALERT_OPENED, a);
    });
    n.show();
  } catch (err) {
    console.warn('[alerts] Windows notification failed:', err instanceof Error ? err.message : err);
  }
}

function raise(a: Omit<DesktopAlert, 'id' | 'at'>): DesktopAlert | null {
  if (!enabled(a.kind)) return null;
  const alert: DesktopAlert = { ...a, id: nextId++, at: new Date().toISOString() };
  alerts.unshift(alert);
  if (alerts.length > KEEP) alerts.length = KEEP;
  push(alert);
  showSystemNotification(alert);
  return alert;
}

function tableOf(order: Pick<FoodOrder, 'tableNumber'>): string | null {
  return order.tableNumber == null || order.tableNumber === '' ? null : String(order.tableNumber);
}

function placeOf(order: Pick<FoodOrder, 'tableNumber' | 'orderType'>): string {
  return where({ tableNumber: tableOf(order), orderType: order.orderType ?? '' });
}

/** A phone placed an order through this PC (POST /api/orders). */
export function alertNewPhoneOrder(p: {
  orderId: string;
  orderNumber: number;
  tableNumber: string | null;
  orderType: 'dine_in' | 'pickup' | 'takeaway';
  itemCount: number;
  deviceId: string;
  deviceName: string;
}): void {
  deviceByOrder.set(p.orderId, p.deviceId);
  const place = p.tableNumber
    ? `Table ${p.tableNumber}`
    : p.orderType === 'pickup'
      ? 'Takeaway'
      : 'Dine-in';
  raise({
    kind: 'new-order',
    orderId: p.orderId,
    orderNumber: p.orderNumber,
    tableNumber: p.tableNumber,
    title: `${place}: new order #${p.orderNumber}`,
    message: `${p.itemCount} item${p.itemCount === 1 ? '' : 's'} from ${p.deviceName || 'a phone'}.`,
  });
}

function onKotFailed(order: FoodOrder, reason: string): void {
  const existing = problems.get(order.id);
  if (existing) {
    // The sweep tried again and failed again: keep one alert, with the latest reason, and no new sound.
    if (existing.message !== reason) {
      existing.message = reason;
      push();
    }
    return;
  }
  const alert = raise({
    kind: 'kot-failed',
    orderId: order.id,
    orderNumber: order.orderNumber,
    tableNumber: tableOf(order),
    title: `${placeOf(order)}: KOT #${order.orderNumber} did not print`,
    message: reason,
    open: true,
  });
  if (!alert) return;
  problems.set(order.id, alert);
  const deviceId = deviceByOrder.get(order.id);
  if (deviceId) {
    publish({
      type: 'kot-failed',
      deviceId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      tableNumber: tableOf(order),
      title: `Order #${order.orderNumber}: KOT not printed`,
      message: `${placeOf(order)}: the kitchen ticket for order #${order.orderNumber} did not print. Tell the kitchen.`,
    });
  }
}

function closeProblem(orderId: string): void {
  const p = problems.get(orderId);
  if (!p) return;
  p.open = false;
  problems.delete(orderId);
  push();
}

/** The KOT printed after all (the sweep, Print KOT, another PC): the banner goes. */
function onKotPrinted(orderId: string): void {
  closeProblem(orderId);
}

/** Someone pressed Dismiss on the banner. */
export function dismissKotProblem(orderId: string): AlertSnapshot {
  closeProblem(orderId);
  return getAlertSnapshot();
}

/** The bell was opened: everything so far counts as read. */
export function markAlertsRead(): AlertSnapshot {
  lastReadId = nextId - 1;
  push();
  return getAlertSnapshot();
}

export function clearAlerts(): AlertSnapshot {
  for (let i = alerts.length - 1; i >= 0; i--) if (!alerts[i].open) alerts.splice(i, 1);
  lastReadId = nextId - 1;
  push();
  return getAlertSnapshot();
}

export function saveAlertSettings(patch: Partial<AlertSettings>): AlertSnapshot {
  config.alertSettings = { ...config.alertSettings, ...patch };
  push();
  return getAlertSnapshot();
}

/** Each look at the outlet's open orders (notificationHub, every 5 s with phones paired, else 30 s). */
function onOrderWatch(snap: OrderWatchSnapshot, now: Date): void {
  for (const o of snap.orders) if (o.deviceId) deviceByOrder.set(o.orderId, o.deviceId);
  if (deviceByOrder.size > 500) {
    const open = new Set(snap.orders.map((o) => o.orderId));
    for (const id of [...deviceByOrder.keys()]) if (!open.has(id)) deviceByOrder.delete(id);
  }
  const late = lateAlerts(lateMemory, snap, now); // always run, so memory stays current while the setting is off
  for (const l of late) {
    raise({
      kind: 'late',
      orderId: l.orderId,
      orderNumber: l.orderNumber,
      tableNumber: l.tableNumber,
      title: l.title,
      message: l.message,
    });
  }
}

export function startDesktopAlerts(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter;
  if (started) return;
  started = true;
  orderManager.on('kot-failed', (order: FoodOrder, reason: string) => onKotFailed(order, reason));
  orderManager.on('kot-printed', (orderId: string) => onKotPrinted(orderId));
  // With no phone paired the hub reads the watch only for late alerts, so only while they are on.
  addOrderWatchListener({ wanted: () => settings().late, onSnapshot: onOrderWatch });
}
