import type { BrowserWindow } from 'electron';
import { db, offline, onLocalWrite } from './data';
import { config } from './config';
import { IpcChannels } from '../shared/ipc';
import type { LiveChange, LiveChangeScope } from '../shared/liveTypes';
import { broadcastChange } from './notificationHub';
import { invalidateTablesForPhones } from './remoteOrderManager';

/**
 * liveUpdates.ts: keeps the screens and the phones current without a refresh
 * button (docs/LIVE_UPDATES.md).
 *
 * Three sources, one output:
 *  - local: a write on this computer through db.* (its own screens, and the
 *    phones that place orders through its HTTP API) is announced at once;
 *  - remote: db.live.watch reports changes made on other computers (how it
 *    finds out is the data layer's business);
 *  - safety: every 60 s everything is reloaded anyway, in case a change was
 *    missed (connection dropped, backend not updated yet), and when the
 *    connection comes back after being offline.
 * Changes within 250 ms are sent as one, to the window (IPC LIVE_CHANGED) and
 * to every phone that asked for change events on /api/events.
 */

const DEBOUNCE_MS = 250;
const SAFETY_MS = 60_000;

let getWindow: () => BrowserWindow | null = () => null;
let stopWatch: (() => void) | null = null;
let watchedOutlet = '';
let stopLocal: (() => void) | null = null;
let stopMonitor: (() => void) | null = null;
let safetyTimer: ReturnType<typeof setInterval> | null = null;
let pending: { scopes: Set<LiveChangeScope>; origin: LiveChange['origin'] } | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastSentAt = 0;

const ORIGIN_RANK: Record<LiveChange['origin'], number> = { safety: 0, remote: 1, local: 2 };

function queue(scopes: LiveChangeScope[], origin: LiveChange['origin']): void {
  if (!pending) pending = { scopes: new Set(), origin };
  for (const s of scopes) pending.scopes.add(s);
  if (ORIGIN_RANK[origin] > ORIGIN_RANK[pending.origin]) pending.origin = origin;
  if (!flushTimer) flushTimer = setTimeout(flush, DEBOUNCE_MS);
}

function flush(): void {
  flushTimer = null;
  if (!pending) return;
  const change: LiveChange = { scopes: [...pending.scopes], origin: pending.origin, at: new Date().toISOString() };
  pending = null;
  lastSentAt = Date.now();
  if (change.scopes.includes('tables') || change.scopes.includes('orders')) invalidateTablesForPhones();
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(IpcChannels.LIVE_CHANGED, change);
  broadcastChange(change);
}

/** (Re)starts watching this PC's outlet. Call after sign-in or when the outlet changes. */
export function restartLiveWatch(): void {
  stopWatch?.();
  stopWatch = null;
  watchedOutlet = config.outletId;
  if (!watchedOutlet) return;
  stopWatch = db.live?.watch(watchedOutlet, (scopes) => queue(scopes, 'remote')) ?? null;
}

export function startLiveUpdates(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter;
  if (safetyTimer) return;
  stopLocal = onLocalWrite((scopes) => queue(scopes, 'local'));
  let wasOffline = offline.monitor.isOffline();
  stopMonitor = offline.monitor.onChange((snap) => {
    const nowOffline = snap.state === 'offline';
    if (wasOffline && !nowOffline) queue(['orders', 'tables'], 'safety');
    wasOffline = nowOffline;
  });
  restartLiveWatch();
  safetyTimer = setInterval(() => {
    if (config.outletId !== watchedOutlet) restartLiveWatch();
    if (offline.monitor.isOffline()) return;
    if (Date.now() - lastSentAt >= SAFETY_MS - 1000) queue(['orders', 'tables'], 'safety');
  }, SAFETY_MS);
  safetyTimer.unref?.();
}

export function stopLiveUpdates(): void {
  stopWatch?.();
  stopLocal?.();
  stopMonitor?.();
  if (safetyTimer) clearInterval(safetyTimer);
  if (flushTimer) clearTimeout(flushTimer);
  stopWatch = stopLocal = stopMonitor = null;
  safetyTimer = flushTimer = null;
  pending = null;
}
