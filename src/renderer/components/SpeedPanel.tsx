/**
 * About > Speed: response times of the phone API, this PC's calls to the main
 * process and screen loads, measured since the app started (docs/TIMINGS.md).
 * Reads the numbers only when opened or refreshed; nothing polls.
 */
import { useCallback, useEffect, useState } from 'react';
import type { TimingKind, TimingSnapshot, TimingStat } from '@shared/timingTypes';
import { useConfirm } from '../context/ConfirmContext';
import page from '../styles/Page.module.css';
import styles from '../styles/SpeedPanel.module.css';

const TABS: { kind: TimingKind; label: string; hint: string }[] = [
  { kind: 'api', label: 'Phone API', hint: 'Each phone call, from arrival at this PC until the reply was sent.' },
  { kind: 'screen', label: 'Screens', hint: 'From the tap that opened a screen until its data was drawn. One number per opening.' },
  { kind: 'ipc', label: 'App calls', hint: 'Each call from this PC’s screens to the app’s main process (mostly the database round trip).' },
];

/** A 95th percentile above this is shown in amber. */
const SLOW_MS: Record<TimingKind, number> = { api: 1000, screen: 2000, ipc: 1000 };

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

function asText(snap: TimingSnapshot): string {
  const head = ['kind', 'name', 'count', 'errors', 'avg ms', 'p50 ms', 'p95 ms', 'max ms', 'slowest at'].join('\t');
  const rows = snap.stats.map((s) => [s.kind, s.name, s.count, s.errors, s.avgMs, s.p50Ms, s.p95Ms, s.maxMs, s.maxAt].join('\t'));
  return [`Speed measurements ${snap.since} to ${snap.takenAt}`, head, ...rows].join('\n');
}

export function SpeedPanel() {
  const confirm = useConfirm();
  const [snap, setSnap] = useState<TimingSnapshot | null>(null);
  const [kind, setKind] = useState<TimingKind>('api');
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSnap(await window.api.getTimings());
    } catch {
      setNote('Could not read the measurements.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reset = async () => {
    const ok = await confirm({
      title: 'Reset speed measurements?',
      message: 'All numbers start again from zero. The summaries already written to main.log stay.',
      confirmLabel: 'Reset',
    });
    if (!ok) return;
    await window.api.resetTimings();
    setNote(null);
    await load();
  };

  const copy = async () => {
    if (!snap) return;
    try {
      await navigator.clipboard.writeText(asText(snap));
      setNote('Copied. Paste it into a message or a spreadsheet.');
    } catch {
      setNote('Could not copy to the clipboard.');
    }
  };

  const rows: TimingStat[] = (snap?.stats ?? []).filter((s) => s.kind === kind);
  const tab = TABS.find((t) => t.kind === kind)!;

  return (
    <section className={page.section}>
      <h3>Speed</h3>
      <p className={page.muted}>
        How long the phone API, this PC&apos;s calls and screen loads take, measured on this PC
        {snap ? ` since ${new Date(snap.since).toLocaleString()}` : ''}. p95: 95 of every 100 calls
        were at least this fast. A summary is also written to main.log every 30 minutes.
      </p>
      <div className={styles.bar}>
        {TABS.map((t) => (
          <button key={t.kind} className={t.kind === kind ? `${styles.chip} ${styles.active}` : styles.chip} onClick={() => setKind(t.kind)}>
            {t.label} ({(snap?.stats ?? []).filter((s) => s.kind === t.kind).length})
          </button>
        ))}
        <span className={styles.spacer} />
        <button className={styles.btn} onClick={() => void load()}>Refresh</button>
        <button className={styles.btn} onClick={() => void copy()} disabled={!snap || snap.stats.length === 0}>
          Copy
        </button>
        <button className={styles.btn} onClick={() => void reset()}>Reset</button>
      </div>
      <p className={page.muted}>{tab.hint}</p>
      {rows.length === 0 ? (
        <p className={page.muted}>
          {kind === 'screen'
            ? 'Nothing measured yet. Open Dashboard, Orders list, New order or another main screen, then Refresh.'
            : 'Nothing measured yet.'}
        </p>
      ) : (
        <div className={styles.scroll}>
          <table className={page.table}>
            <thead>
              <tr>
                <th>{kind === 'api' ? 'Endpoint' : kind === 'screen' ? 'Screen' : 'Call'}</th>
                <th className={styles.num}>Count</th>
                <th className={styles.num}>Errors</th>
                <th className={styles.num}>Average</th>
                <th className={styles.num}>Median</th>
                <th className={styles.num}>p95</th>
                <th className={styles.num}>Slowest</th>
                <th className={styles.num}>Last</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.name}>
                  <td className={styles.name}>{s.name}</td>
                  <td className={styles.num}>{s.count}</td>
                  <td className={styles.num}>{s.errors || ''}</td>
                  <td className={styles.num}>{fmtMs(s.avgMs)}</td>
                  <td className={styles.num}>{fmtMs(s.p50Ms)}</td>
                  <td className={s.p95Ms > SLOW_MS[kind] ? `${styles.num} ${styles.slow}` : styles.num}>{fmtMs(s.p95Ms)}</td>
                  <td className={styles.num} title={`at ${new Date(s.maxAt).toLocaleTimeString()}`}>
                    {fmtMs(s.maxMs)}
                  </td>
                  <td className={styles.num}>{fmtMs(s.lastMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {note && <p className={styles.note}>{note}</p>}
    </section>
  );
}
