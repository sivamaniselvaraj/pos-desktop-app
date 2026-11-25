import type { BrowserWindow } from 'electron';
import { config } from './config';
import { db, offline } from './data';
import { refreshMenuCache } from './menuCache';
import { IpcChannels } from '../shared/ipc';
import type { OfflineStatus } from '../shared/offlineTypes';

/**
 * offlineManager.ts
 * ---------------------------------------------------------------------------
 * Offline mode, phase 1 (docs/OFFLINE_MODE.md): starts the health check and
 * the local database, keeps this computer's copy of the outlet's reference
 * data fresh, makes the daily backup and tells the UI (header pill, offline
 * banner) when the connection changes.
 *
 * The copy is refreshed: when the app goes back online, after a sign-in,
 * and every 5 minutes while online. Each read goes through `db.*`, and the
 * data layer saves the answer locally (only when it changed). Orders are not
 * kept offline yet (phase 2 and 3).
 * ---------------------------------------------------------------------------
 */

const REFRESH_EVERY_MS = 5 * 60 * 1000;
const BACKUP_CHECK_EVERY_MS = 60 * 60 * 1000;

let getWindow: () => BrowserWindow | null = () => null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let backupTimer: ReturnType<typeof setInterval> | null = null;
let offChange: (() => void) | null = null;
let refreshing: Promise<void> | null = null;
let lastRefreshError: string | null = null;

export function getOfflineStatus(): OfflineStatus {
  const s = offline.status();
  return {
    state: s.connectivity.state,
    since: s.connectivity.since,
    lastOnlineAt: s.connectivity.lastOnlineAt,
    localCopyAt: s.store?.lastRefreshedAt ?? null,
    localStore: s.store ? 'ready' : 'unavailable',
    localStoreError: s.storeError,
    encrypted: Boolean(s.store?.encrypted && s.keyProtectedByOs),
    lowDisk: s.store?.lowDisk ?? false,
    freeMb: s.store?.freeBytes != null ? Math.floor(s.store.freeBytes / (1024 * 1024)) : null,
    notice: s.store?.recovered ?? null,
    lastRefreshError,
  };
}

function push(): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(IpcChannels.OFFLINE_STATUS, getOfflineStatus());
}

/** Is the database reachable? Uses the health check's last answer; checks now only before the first one. */
export async function isDatabaseConnected(): Promise<boolean> {
  const state = offline.monitor.snapshot().state;
  if (state === 'unknown') return offline.monitor.checkNow();
  return state !== 'offline';
}

/**
 * Reads the outlet's reference data once through `db.*` so the local copy
 * is up to date. Shares a refresh already running. Never throws.
 */
export function refreshLocalCopy(): Promise<void> {
  if (refreshing) return refreshing;
  if (!offline.getStore() || !db.isConfigured() || offline.monitor.isOffline()) return Promise.resolve();
  const outletId = config.outletId;
  if (!outletId) return Promise.resolve();

  const endSync = offline.monitor.beginSync();
  push();
  refreshing = (async () => {
    const userId = offline.facade.currentUser;
    const reads: Promise<unknown>[] = [
      refreshMenuCache(), // also refreshes the in-memory menu the phones read
      db.orders.fetchOutletById(outletId),
      db.access.getReceiptText(outletId),
      db.tables.listTableNumbers(outletId),
      db.auth.loadOutletName(outletId),
    ];
    if (userId) {
      reads.push(
        db.auth.loadProfile(userId),
        db.access.fetchMyAccess(),
        db.menu.listCategories(outletId),
        db.orderEntry.getTaxRates(),
        db.kots.getWorkflow(),
        //db.orderAdmin.listKotSetup(),
        db.orderAdmin.getDiscountSettings(),
        db.orderAdmin.getDiscountOptions(),
        //db.remoteOrders.getKotSettings(),
      );
    }
    const results = await Promise.allSettled(reads);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    lastRefreshError = failed.length
      ? `${failed.length} of ${results.length} reads failed (${failed[0].reason instanceof Error ? failed[0].reason.message : String(failed[0].reason)})`
      : null;
    if (failed.length) console.warn(`[offline] local copy refresh: ${lastRefreshError}`);
    offline.backupIfDue();
  })().finally(() => {
    refreshing = null;
    endSync();
    push();
  });
  return refreshing;
}

/** Call once after app ready, after the env is loaded. */
export function startOfflineMode(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter;
  offline.openStore(() => config.outletId);
  offline.backupIfDue();

  if (!db.isConfigured()) {
    console.warn('[offline] the database is not configured: the health check is not started.');
    return;
  }

  let previous = offline.monitor.snapshot().state;
  offChange = offline.monitor.onChange((snap) => {
    console.log(`[offline] connection: ${snap.state}`);
    const cameBack = (previous === 'offline' || previous === 'unknown') && snap.state === 'online';
    previous = snap.state;
    push();
    if (cameBack) void refreshLocalCopy();
  });
  offline.monitor.start();

  refreshTimer = setInterval(() => void refreshLocalCopy(), REFRESH_EVERY_MS);
  backupTimer = setInterval(() => offline.backupIfDue(), BACKUP_CHECK_EVERY_MS);
}

export function stopOfflineMode(): void {
  offline.monitor.stop();
  offChange?.();
  offChange = null;
  if (refreshTimer) clearInterval(refreshTimer);
  if (backupTimer) clearInterval(backupTimer);
  refreshTimer = backupTimer = null;
  offline.closeStore();
}
