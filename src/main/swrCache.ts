/**
 * swrCache.ts: a small in-memory cache for one value ("stale while revalidate").
 * No database or Electron import, so it is tested in plain Node
 * (tests/api/swrCache.test.ts). Used for the phones' GET /api/tables and the
 * organisation settings in GET /api/me (docs/API_CACHE.md).
 *
 *  - younger than freshMs: the cached value, no database call;
 *  - between freshMs and staleMs, when allowStale() is true: the cached value at
 *    once, and one refresh starts in the background for the next caller;
 *  - older, or no value, or allowStale() false: the caller waits for a fresh read
 *    and sees its error if it fails;
 *  - many callers at the same time share one read;
 *  - invalidate() drops the value, and a read that started before it is never
 *    stored or handed to a later caller;
 *  - a failed background refresh drops the value, so the next caller waits for a
 *    fresh read and sees the real error instead of an ever older answer;
 *  - key(): when it changes (another signed-in user, another outlet), the cached
 *    value is never served: it belongs to someone else.
 */

export interface SwrCacheOptions<T> {
  load: () => Promise<T>;
  freshMs: number;
  /** Up to this age the cached value may be served while a refresh runs. 0 or <= freshMs: never. */
  staleMs?: number;
  /** Checked on every call; false makes every non-fresh call wait (for example while offline). */
  allowStale?: () => boolean;
  /** Whose value this is. A different key never sees the cached value. */
  key?: () => string;
  now?: () => number;
  /** Called when a background refresh fails (for the log). */
  onBackgroundError?: (err: unknown) => void;
}

export interface SwrCache<T> {
  get(): Promise<T>;
  invalidate(): void;
  /** For tests and the log: what the last get() did. */
  readonly lastServed: 'fresh' | 'stale' | 'loaded' | 'none';
}

export function createSwrCache<T>(opts: SwrCacheOptions<T>): SwrCache<T> {
  const now = opts.now ?? Date.now;
  const keyOf = opts.key ?? (() => '');
  const staleMs = opts.staleMs ?? 0;
  let value: { at: number; key: string; v: T } | null = null;
  let inflight: { gen: number; key: string; p: Promise<T> } | null = null;
  let generation = 0;
  let lastServed: SwrCache<T>['lastServed'] = 'none';

  function read(key: string): Promise<T> {
    if (inflight && inflight.gen === generation && inflight.key === key) return inflight.p;
    const gen = generation;
    const p = opts.load().then(
      (v) => {
        if (gen === generation && keyOf() === key) value = { at: now(), key, v };
        return v;
      },
      (err) => {
        // A failed read never leaves an older value behind for this key.
        if (gen === generation && value?.key === key) value = null;
        throw err;
      },
    );
    const entry = { gen, key, p };
    inflight = entry;
    void p.then(
      () => {
        if (inflight === entry) inflight = null;
      },
      () => {
        if (inflight === entry) inflight = null;
      },
    );
    return p;
  }

  return {
    async get(): Promise<T> {
      const key = keyOf();
      if (value && value.key === key) {
        const age = now() - value.at;
        if (age < opts.freshMs) {
          lastServed = 'fresh';
          return value.v;
        }
        if (age < staleMs && (opts.allowStale?.() ?? true)) {
          lastServed = 'stale';
          const cached = value.v;
          read(key).catch((err) => opts.onBackgroundError?.(err));
          return cached;
        }
      }
      lastServed = 'loaded';
      return read(key);
    },
    invalidate(): void {
      value = null;
      inflight = null;
      generation += 1;
    },
    get lastServed() {
      return lastServed;
    },
  };
}
