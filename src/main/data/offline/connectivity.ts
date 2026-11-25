/**
 * data/offline/connectivity.ts
 * ---------------------------------------------------------------------------
 * Is the cloud database reachable? A health check every 5 s (a one-row read,
 * the same check the old "DB" dot used), not navigator.onLine: a router can be
 * up while the internet is not.
 *
 * States: online, offline, syncing (online while the local copy is being
 * refreshed), unknown (before the first check). Two failed checks in a row
 * make it offline, so one slow answer does not flip the app; one good check
 * makes it online again. A read that fails in between can ask for a check at
 * once (checkNow), so the app does not wait for the next tick.
 * ---------------------------------------------------------------------------
 */

export type ConnectivityState = 'unknown' | 'online' | 'offline' | 'syncing';

export interface ConnectivitySnapshot {
  state: ConnectivityState;
  /** When the current state began (ISO). */
  since: string;
  lastOnlineAt: string | null;
  lastCheckAt: string | null;
}

export const CHECK_INTERVAL_MS = 5_000;
export const CHECK_TIMEOUT_MS = 4_000;
/** Failed checks in a row before the state becomes offline. */
export const FAILS_TO_OFFLINE = 2;

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export class ConnectivityMonitor {
  private state: ConnectivityState = 'unknown';
  private since = new Date().toISOString();
  private lastOnlineAt: string | null = null;
  private lastCheckAt: string | null = null;
  private fails = 0;
  private syncing = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<boolean> | null = null;
  private listeners = new Set<(s: ConnectivitySnapshot) => void>();

  constructor(
    /** Resolves true when the database answered. Must not throw for "unreachable". */
    private readonly probe: () => Promise<boolean>,
    private readonly opts: { intervalMs?: number; timeoutMs?: number; failsToOffline?: number } = {},
  ) {}

  start(): void {
    if (this.timer) return;
    void this.checkNow();
    this.timer = setInterval(() => void this.checkNow(), this.opts.intervalMs ?? CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): ConnectivitySnapshot {
    return { state: this.state, since: this.since, lastOnlineAt: this.lastOnlineAt, lastCheckAt: this.lastCheckAt };
  }

  /** True when the last checks failed. 'unknown' counts as not offline, so the first reads still try the database. */
  isOffline(): boolean {
    return this.state === 'offline';
  }

  onChange(cb: (s: ConnectivitySnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Checks now (shares a check already running). Resolves true when the
   * database answered. `force` skips the two-strikes rule: one failure is
   * enough (used after a read has already failed).
   */
  checkNow(force = false): Promise<boolean> {
    if (!this.inFlight) {
      this.inFlight = withTimeout(this.probe(), this.opts.timeoutMs ?? CHECK_TIMEOUT_MS, 'timeout')
        .catch(() => false)
        .then((ok) => {
          this.inFlight = null;
          this.record(ok, force);
          return ok;
        });
    } else if (force) {
      return this.inFlight.then((ok) => {
        if (!ok) this.record(false, true);
        return ok;
      });
    }
    return this.inFlight;
  }

  /** Marks a local-copy refresh as running; online shows as syncing until the returned function is called. */
  beginSync(): () => void {
    this.syncing++;
    this.recompute();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.syncing = Math.max(0, this.syncing - 1);
      this.recompute();
    };
  }

  private record(ok: boolean, force: boolean): void {
    const now = new Date().toISOString();
    this.lastCheckAt = now;
    if (ok) {
      this.fails = 0;
      this.lastOnlineAt = now;
    } else {
      this.fails = force ? Math.max(this.fails + 1, this.opts.failsToOffline ?? FAILS_TO_OFFLINE) : this.fails + 1;
    }
    this.recompute();
  }

  private recompute(): void {
    let next: ConnectivityState;
    if (this.fails >= (this.opts.failsToOffline ?? FAILS_TO_OFFLINE)) next = 'offline';
    else if (this.lastOnlineAt === null) next = this.state === 'offline' ? 'offline' : 'unknown';
    else next = this.syncing > 0 ? 'syncing' : 'online';
    if (next === this.state) return;
    this.state = next;
    this.since = new Date().toISOString();
    const snap = this.snapshot();
    for (const cb of this.listeners) {
      try {
        cb(snap);
      } catch (err) {
        console.error('[connectivity] listener failed:', err);
      }
    }
  }
}
