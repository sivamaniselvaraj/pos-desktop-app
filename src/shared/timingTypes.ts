/**
 * shared/timingTypes.ts: speed measurements (docs/TIMINGS.md), shared by the
 * main process, the preload bridge and the About page.
 */

/** api: a phone's HTTP call; ipc: a call from this PC's screens to the main process; screen: a screen opening until its data shows. */
export type TimingKind = 'api' | 'ipc' | 'screen';

/** One measured thing (an endpoint, an IPC call or a screen) since the app started or since Reset. */
export interface TimingStat {
  kind: TimingKind;
  /** "GET /api/tables", "list-tables", "Dashboard". */
  name: string;
  count: number;
  /** Calls that failed (HTTP 4xx/5xx, an IPC call that threw, a screen that showed an error). */
  errors: number;
  avgMs: number;
  /** Median and 95th percentile of the last SAMPLE_LIMIT calls. */
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /** When the slowest call happened (ISO time). */
  maxAt: string;
  lastMs: number;
  lastAt: string;
}

export interface TimingSnapshot {
  /** App start or the last Reset (ISO time). */
  since: string;
  takenAt: string;
  stats: TimingStat[];
}
