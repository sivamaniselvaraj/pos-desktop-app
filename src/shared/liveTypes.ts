/**
 * shared/liveTypes.ts: types of live updates (docs/LIVE_UPDATES.md), shared by
 * the main process, the preload bridge and the screens.
 */

/** What changed for this outlet: its orders (with their items) or its tables. */
export type LiveChangeScope = 'orders' | 'tables';

/** Pushed to the screens (IPC LIVE_CHANGED) when this outlet's orders or tables changed. */
export interface LiveChange {
  scopes: LiveChangeScope[];
  /** 'local': written on this computer (its screens or its phones); 'remote': seen from the backend; 'safety': the slow reload. */
  origin: 'local' | 'remote' | 'safety';
  at: string;
}
