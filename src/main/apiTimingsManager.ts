/**
 * timings.ts
 * ---------------------------------------------------------------------------
 * Speed measurements kept in memory (docs/TIMINGS.md):
 *  - api:    every phone HTTP call, by route ("GET /api/tables/:tableId")
 *  - ipc:    every call from this PC's screens to the main process ("list-tables")
 *  - screen: a screen opening until its first data shows ("Dashboard")
 *
 * Per name: count, errors, average, median and 95th percentile of the last
 * SAMPLE_LIMIT calls, slowest (and when), last. Recording is a few array writes,
 * so it costs nothing a user could notice. Nothing is saved to disk except the
 * summary lines written to main.log every SUMMARY_EVERY_MS.
 *
 * Pure module (no Electron import) so it runs in `npm run test:api`.
 * ---------------------------------------------------------------------------
 */
import type { NextFunction, Request, Response } from 'express';
import type { TimingKind, TimingSnapshot, TimingStat } from '../shared/timingTypes';

/** Recent calls kept per name for the percentiles. */
export const SAMPLE_LIMIT = 500;
/** Names kept at most; later new names are counted under "(other)". */
export const NAME_LIMIT = 400;
export const SUMMARY_EVERY_MS = 30 * 60 * 1000;

interface Entry {
  kind: TimingKind;
  name: string;
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  maxAt: number;
  lastMs: number;
  lastAt: number;
  samples: Float64Array;
  next: number;
}

const round = (ms: number) => Math.round(ms * 10) / 10;

/** Nearest-rank percentile of a sorted list. */
function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function createTimingStore(now: () => number = Date.now) {
  let entries = new Map<string, Entry>();
  let since = now();

  function record(kind: TimingKind, name: string, ms: number, failed = false): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    let key = `${kind} ${name}`;
    let e = entries.get(key);
    if (!e) {
      if (entries.size >= NAME_LIMIT) {
        name = '(other)';
        key = `${kind} ${name}`;
        e = entries.get(key);
      }
      if (!e) {
        e = { kind, name, count: 0, errors: 0, totalMs: 0, maxMs: 0, maxAt: 0, lastMs: 0, lastAt: 0, samples: new Float64Array(SAMPLE_LIMIT), next: 0 };
        entries.set(key, e);
      }
    }
    const at = now();
    e.count++;
    if (failed) e.errors++;
    e.totalMs += ms;
    if (ms >= e.maxMs) {
      e.maxMs = ms;
      e.maxAt = at;
    }
    e.lastMs = ms;
    e.lastAt = at;
    e.samples[e.next % SAMPLE_LIMIT] = ms;
    e.next++;
  }

  function stat(e: Entry): TimingStat {
    const n = Math.min(e.next, SAMPLE_LIMIT);
    const sorted = e.samples.slice(0, n).sort();
    return {
      kind: e.kind,
      name: e.name,
      count: e.count,
      errors: e.errors,
      avgMs: round(e.totalMs / e.count),
      p50Ms: round(percentile(sorted, 50)),
      p95Ms: round(percentile(sorted, 95)),
      maxMs: round(e.maxMs),
      maxAt: new Date(e.maxAt).toISOString(),
      lastMs: round(e.lastMs),
      lastAt: new Date(e.lastAt).toISOString(),
    };
  }

  /** All stats, slowest 95th percentile first within each kind (api, screen, ipc). */
  function snapshot(): TimingSnapshot {
    const order: Record<TimingKind, number> = { api: 0, screen: 1, ipc: 2 };
    const stats = [...entries.values()].map(stat).sort((a, b) => order[a.kind] - order[b.kind] || b.p95Ms - a.p95Ms);
    return { since: new Date(since).toISOString(), takenAt: new Date(now()).toISOString(), stats };
  }

  function reset(): void {
    entries = new Map();
    since = now();
  }

  /** Total calls recorded, to tell whether anything happened since the last summary. */
  function totalCount(): number {
    let n = 0;
    for (const e of entries.values()) n += e.count;
    return n;
  }

  return { record, snapshot, reset, totalCount };
}

export type TimingStore = ReturnType<typeof createTimingStore>;

/** The app's one store. */
export const timings = createTimingStore();

/** High-resolution clock in milliseconds. */
export function nowMs(): number {
  return performance.now();
}

/**
 * The route name an HTTP call is filed under: the Express route pattern when a
 * route answered ("GET /api/order/:orderId"), else the path with id-like parts
 * replaced by ":id" so refused calls do not create a name per order.
 */
export function apiRouteName(method: string, routePattern: string | undefined, path: string): string {
  if (routePattern) return `${method} ${routePattern}`;
  const clean = path
    .split('?')[0]
    .split('/')
    .map((part) => (/\d/.test(part) || part.length > 40 ? ':id' : part))
    .join('/');
  return `${method} ${clean}`;
}

/** Lines for main.log: every API route and screen, and the 10 slowest IPC calls. */
export function summaryLines(snap: TimingSnapshot): string[] {
  const fmt = (s: TimingStat) =>
    `[timing] ${s.kind} ${s.name}: n=${s.count} err=${s.errors} avg=${s.avgMs}ms p50=${s.p50Ms}ms p95=${s.p95Ms}ms max=${s.maxMs}ms`;
  const api = snap.stats.filter((s) => s.kind === 'api');
  const screens = snap.stats.filter((s) => s.kind === 'screen');
  const ipc = snap.stats.filter((s) => s.kind === 'ipc').slice(0, 10);
  return [`[timing] summary since ${snap.since}`, ...api.map(fmt), ...screens.map(fmt), ...ipc.map(fmt)];
}

/** Long-lived streams: their "time" is how long the phone stayed connected, not a response time. */
const NOT_TIMED = /^\/api\/events(\/|\?|$)/;

/**
 * Express middleware (mounted on /api right after the audit log): times each
 * call from arrival until the reply is sent and files it under its route.
 * Changes nothing in the request or the reply.
 */
export function apiTiming(store: TimingStore = timings) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = nowMs();
    res.on('finish', () => {
      const url = req.originalUrl || req.url;
      if (NOT_TIMED.test(url)) return;
      const pattern = (req.route as { path?: unknown } | undefined)?.path;
      const name = apiRouteName(req.method, typeof pattern === 'string' ? pattern : undefined, url);
      store.record('api', name, nowMs() - started, res.statusCode >= 400);
    });
    next();
  };
}
