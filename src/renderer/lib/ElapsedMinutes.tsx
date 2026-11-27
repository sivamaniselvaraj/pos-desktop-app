import { useSyncExternalStore } from 'react';

/**
 * " · 12 min" since `createdAt` on a Dashboard table tile (docs/DASHBOARD_TABLES.md).
 * Only this label re-renders on the 30 s tick, not the page or the tiles. One
 * shared timer for every label; it runs only while a label is on screen.
 */
const TICK_MS = 30_000;
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, TICK_MS);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getNow(): number {
  // No timer yet (first label on screen): start from the time of this render.
  // The 1 s margin keeps repeated reads in one render equal.
  if (!timer && Date.now() - now > 1000) now = Date.now();
  return now;
}

export function elapsedMinutes(createdAt: string | undefined, at: number): number | null {
  if (!createdAt) return null;
  const started = new Date(createdAt).getTime();
  if (Number.isNaN(started)) return null;
  return Math.max(0, Math.round((at - started) / 60000));
}

export function ElapsedMinutes({ createdAt }: { createdAt: string | undefined }) {
  const at = useSyncExternalStore(subscribe, getNow);
  const mins = elapsedMinutes(createdAt, at);
  return <>{mins !== null ? ` · ${mins} min` : ''}</>;
}
