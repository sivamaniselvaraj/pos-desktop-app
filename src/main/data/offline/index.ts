/**
 * data/offline: offline mode, phase 1 (docs/OFFLINE_MODE.md).
 *
 *   localStore.ts     the encrypted SQLite file on this computer (one outlet)
 *   connectivity.ts   the 5 s health check: online / offline / syncing
 *   offlineFacade.ts  wraps the provider's repositories: saves reference
 *                     reads locally, answers them from the copy when offline
 *
 * This file holds the Electron parts: where the file lives (userData) and the
 * encryption key, kept encrypted by the OS (safeStorage: DPAPI on Windows).
 */
import { app, safeStorage } from 'electron';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { LocalStore, type LocalStoreInfo } from './localStore';
import { ConnectivityMonitor, type ConnectivitySnapshot } from './connectivity';
import { OfflineFacade } from './offlineFacade';

export type { ConnectivitySnapshot, ConnectivityState } from './connectivity';
export type { LocalStoreInfo } from './localStore';
export { OfflineError, OFFLINE_MESSAGE } from './offlineFacade';

const KEY_FILE = 'local-store.key';

/** The key of the local database: 32 random bytes, kept encrypted by the OS. */
function loadOrCreateKey(dir: string): { key: string; protectedByOs: boolean } {
  const file = join(dir, KEY_FILE);
  if (existsSync(file)) {
    const stored = readFileSync(file, 'utf8').trim();
    try {
      if (stored.startsWith('enc:')) {
        return { key: safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64')), protectedByOs: true };
      }
      if (stored.startsWith('plain:')) return { key: stored.slice(6), protectedByOs: false };
      throw new Error('unknown key format');
    } catch (err) {
      // The key cannot be read (e.g. the Windows user profile changed). Keep the old
      // file beside it and start a new key; the store then moves the old file aside.
      const aside = `${file}.unreadable-${Date.now()}`;
      renameSync(file, aside);
      console.error(`[offline] the local database key could not be read (${err instanceof Error ? err.message : err}); moved to ${aside}`);
    }
  }
  const key = randomBytes(32).toString('hex');
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(file, 'enc:' + safeStorage.encryptString(key).toString('base64'), { mode: 0o600 });
    return { key, protectedByOs: true };
  }
  // Same rule as the saved sign-in: only where the OS has no keychain (some Linux setups).
  console.warn('[offline] OS encryption is not available: the local database key is stored unprotected.');
  writeFileSync(file, 'plain:' + key, { mode: 0o600 });
  return { key, protectedByOs: false };
}

export interface OfflineStatusParts {
  connectivity: ConnectivitySnapshot;
  store: LocalStoreInfo | null;
  /** Why the local database is not available (null when it is). */
  storeError: string | null;
  keyProtectedByOs: boolean;
}

/** One per app. Created by data/index.ts with the provider's health check. */
export class OfflineMode {
  readonly monitor: ConnectivityMonitor;
  readonly facade: OfflineFacade;
  private store: LocalStore | null = null;
  private storeError: string | null = 'The local database has not been opened yet.';
  private keyProtectedByOs = false;
  private outletId: () => string = () => '';

  constructor(probe: () => Promise<boolean>) {
    this.monitor = new ConnectivityMonitor(probe);
    this.facade = new OfflineFacade({
      monitor: this.monitor,
      getStore: () => this.store,
      getOutletId: () => this.outletId(),
    });
  }

  /**
   * Opens the local database (after app ready: safeStorage needs it). Never
   * throws: when it cannot open, the app runs online only and the status
   * says why.
   */
  openStore(getOutletId: () => string): void {
    this.outletId = getOutletId;
    if (this.store) return;
    try {
      const dir = app.getPath('userData');
      const { key, protectedByOs } = loadOrCreateKey(dir);
      this.keyProtectedByOs = protectedByOs;
      this.store = new LocalStore({ dir, key });
      this.storeError = null;
      const info = this.store.info();
      console.log(
        `[offline] local database open (${info.encrypted ? 'encrypted' : 'not encrypted'}, outlet ${info.outletId ?? 'not bound yet'}, ${info.snapshotCount} saved reads)`,
      );
    } catch (err) {
      this.store = null;
      this.storeError = err instanceof Error ? err.message : String(err);
      console.error('[offline] the local database could not be opened; offline mode is off:', this.storeError);
    }
  }

  closeStore(): void {
    this.store?.close();
    this.store = null;
  }

  getStore(): LocalStore | null {
    return this.store;
  }

  /** Today's backup copy (once a day, 7 kept). Never throws. */
  backupIfDue(): void {
    try {
      this.store?.backupIfDue();
    } catch (err) {
      console.error('[offline] local backup failed:', err instanceof Error ? err.message : err);
    }
  }

  status(): OfflineStatusParts {
    let info: LocalStoreInfo | null = null;
    try {
      info = this.store?.info() ?? null;
    } catch (err) {
      this.storeError = err instanceof Error ? err.message : String(err);
    }
    return { connectivity: this.monitor.snapshot(), store: info, storeError: this.store ? null : this.storeError, keyProtectedByOs: this.keyProtectedByOs };
  }
}
