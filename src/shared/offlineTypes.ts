/**
 * shared/offlineTypes.ts: types of offline mode (docs/OFFLINE_MODE.md), shared by
 * the main process, the preload bridge and the screens.
 */

/** unknown: before the first health check. syncing: online while this computer's copy is being refreshed. */
export type ConnectivityState = 'unknown' | 'online' | 'offline' | 'syncing';

export interface OfflineStatus {
  state: ConnectivityState;
  /** When the current state began (ISO). */
  since: string;
  /** Last successful health check (ISO). */
  lastOnlineAt: string | null;
  /** When this computer's copy of the menu and settings was last confirmed against the database (ISO). */
  localCopyAt: string | null;
  /** unavailable: the local database could not be opened; the app works online only. */
  localStore: 'ready' | 'unavailable';
  localStoreError: string | null;
  /** The local file is encrypted and its key is protected by the OS. */
  encrypted: boolean;
  /** Less than 500 MB free on the disk that holds the local database. */
  lowDisk: boolean;
  freeMb: number | null;
  /** Set when the local file had to be replaced at start (moved aside, restored from a backup or recreated). */
  notice: string | null;
  /** Some reads of the last refresh failed (e.g. a permission this user does not have). */
  lastRefreshError: string | null;
}
