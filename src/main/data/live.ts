/**
 * data/live.ts
 * ---------------------------------------------------------------------------
 * Provider-neutral pieces of live updates (docs/LIVE_UPDATES.md):
 *
 *  - pollVersions: a ready-made LiveRepository.watch for a backend that can
 *    answer "what are this outlet's change counters?". The current provider
 *    uses it; another one may push changes instead and not use it at all.
 *  - timedWatch: what the app uses when a provider has no `live` at all: a
 *    plain reload every 30 seconds, so switching to a new backend never
 *    leaves screens frozen.
 *  - Local writes: every successful write that goes through `db.*` on this
 *    computer (its own screens and the phones on its HTTP API) is announced
 *    at once, without waiting for the backend.
 *
 * Nothing here knows a database, a table or an SDK.
 * ---------------------------------------------------------------------------
 */
import type { LiveChangeScope, LiveWatchOptions } from './ports';

export const ALL_SCOPES: LiveChangeScope[] = ['orders', 'tables'];

/** How often pollVersions looks, and how long it waits after a failure. */
export const POLL_MS = 3_000;
export const POLL_AFTER_FAILURE_MS = 30_000;
/** The reload interval for a provider without live updates. */
export const TIMED_RELOAD_MS = 30_000;

export type LiveVersions = Partial<Record<LiveChangeScope, string | number>>;

/**
 * Reads the outlet's counters every few seconds and calls onChange with the
 * scopes whose counter moved. The first read only sets the baseline. After a
 * failure it waits longer and logs once until a read works again. Never
 * throws.
 */
export function pollVersions(
  read: () => Promise<LiveVersions>,
  onChange: (scopes: LiveChangeScope[]) => void,
  options: LiveWatchOptions & { intervalMs?: number; failureMs?: number; label?: string } = {},
): () => void {
  const every = options.intervalMs ?? POLL_MS;
  const afterFailure = options.failureMs ?? POLL_AFTER_FAILURE_MS;
  const label = options.label ?? 'live';
  let last: LiveVersions | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failing = false;

  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), ms);
    timer.unref?.();
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (options.isPaused?.()) {
      // Paused (offline): forget the baseline so the first read afterwards
      // reports everything as changed and the screens catch up.
      if (last) last = {};
      return schedule(every);
    }
    try {
      const now = await read();
      if (stopped) return;
      if (failing) console.log(`[${label}] change check works again`);
      failing = false;
      if (last) {
        const changed = ALL_SCOPES.filter((s) => String(now[s] ?? '') !== String(last?.[s] ?? ''));
        if (changed.length) onChange(changed);
      }
      last = now;
      schedule(every);
    } catch (err) {
      if (!failing) console.warn(`[${label}] change check failed, trying again in ${Math.round(afterFailure / 1000)} s:`, err instanceof Error ? err.message : err);
      failing = true;
      schedule(afterFailure);
    }
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** Calls onChange with every scope on a fixed interval (providers without live updates). */
export function timedWatch(onChange: (scopes: LiveChangeScope[]) => void, options: LiveWatchOptions & { intervalMs?: number } = {}): () => void {
  const t = setInterval(() => {
    if (!options.isPaused?.()) onChange(ALL_SCOPES);
  }, options.intervalMs ?? TIMED_RELOAD_MS);
  t.unref?.();
  return () => clearInterval(t);
}

// ---- Local writes ---------------------------------------------------------

/**
 * The `db.*` methods that change orders or tables, with what they change.
 * Add a new write here when it should update the screens at once. A write
 * left out still shows on the next change check.
 */
export const LOCAL_WRITES: Record<string, Record<string, LiveChangeScope[]>> = {
  orders: {
    markItemsKotPrinted: ['orders'],
    markOrdersCompleted: ['orders', 'tables'],
    markOrdersBillPrinted: ['orders'],
  },
  orderAdmin: {
    editItem: ['orders'],
    deleteItem: ['orders'],
    cancelOrder: ['orders', 'tables'],
    cancelInvoice: ['orders', 'tables'],
    completeOrder: ['orders', 'tables'],
    completeInvoice: ['orders', 'tables'],
    setOrderDiscount: ['orders'],
  },
  orderEntry: {
    placeDineInOrder: ['orders', 'tables'],
    placePickupOrder: ['orders'],
  },
  remoteOrders: {
    placeOrderAs: ['orders', 'tables'],
    markItemServed: ['orders'],
  },
  kots: {
    move: ['orders'],
    moveAs: ['orders'],
    moveItems: ['orders'],
    moveItemsAs: ['orders'],
  },
  tables: {
    savePayment: ['orders', 'tables'],
    insert: ['tables'],
    update: ['tables'],
    remove: ['tables'],
    setStatus: ['tables'],
  },
};

const localListeners = new Set<(scopes: LiveChangeScope[]) => void>();

/** Called after each successful local write listed in LOCAL_WRITES. */
export function onLocalWrite(cb: (scopes: LiveChangeScope[]) => void): () => void {
  localListeners.add(cb);
  return () => localListeners.delete(cb);
}

function announce(scopes: LiveChangeScope[]): void {
  for (const cb of localListeners) {
    try {
      cb(scopes);
    } catch (err) {
      console.error('[live] listener failed:', err);
    }
  }
}

const tracked = new WeakMap<object, object>();

/** The repository with its LOCAL_WRITES methods announcing success (cached per repository object). */
export function trackLocalWrites<T extends object>(repoName: string, repo: T): T {
  const writes = LOCAL_WRITES[repoName];
  if (!writes) return repo;
  const cached = tracked.get(repo);
  if (cached) return cached as T;
  const out = { ...repo } as Record<string, unknown>;
  for (const [method, scopes] of Object.entries(writes)) {
    const fn = (repo as Record<string, unknown>)[method];
    if (typeof fn !== 'function') continue;
    out[method] = async (...args: unknown[]) => {
      const result = await (fn as (...a: unknown[]) => unknown).apply(repo, args);
      announce(scopes);
      return result;
    };
  }
  tracked.set(repo, out);
  return out as T;
}
