import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MenuAvailabilityReport } from '@shared/types';
import styles from '../styles/MenuAvailability.module.css';
import { formatMoney, formatNumber, formatDateTime } from '../lib/format';
import { presetRange } from '../lib/dateRange';
import { PeriodPicker } from '../components/PeriodPicker';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "45 min", "6.5 h", "2 d 3 h". */
function fmtHours(h: number): string {
  if (h <= 0) return '0 h';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 24) return `${Number(h.toFixed(1))} h`;
  const d = Math.floor(h / 24);
  const rest = Math.round(h - d * 24);
  return rest ? `${d} d ${rest} h` : `${d} d`;
}
/** The report sends outlet-local timestamps without a zone: show them as they are. */
const fmtLocal = (s: string): string => s.replace('T', ' ').slice(0, 16);

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function download(name: string, header: string[], rows: (string | number)[][]): void {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(','));
  const blob = new Blob([`${String.fromCharCode(0xfeff)}${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function Bars({ data, label }: { data: { key: string; value: number }[]; label: (k: string, v: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className={styles.bars}>
      {data.map((d) => (
        <div key={d.key} className={styles.barCol} title={label(d.key, d.value)}>
          <div className={styles.barTrack}>
            <i style={{ height: `${(d.value / max) * 100}%` }} />
          </div>
          <span>{d.key}</span>
        </div>
      ))}
    </div>
  );
}

export function MenuAvailabilityTab() {
  const [range, setRange] = useState(() => presetRange('today'));
  const [report, setReport] = useState<MenuAvailabilityReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [itemFilter, setItemFilter] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async (from: string, to: string) => {
    setLoading(true);
    setError(null);
    try {
      setReport(await window.api.getMenuAvailability(from, to));
    } catch (err) {
      setReport(null);
      setError(err instanceof Error ? err.message : 'Could not load the report');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setItemFilter(null);
    if (range.from && range.to && range.from <= range.to) void load(range.from, range.to);
  }, [range, load]);

  const timeline = useMemo(
    () => (report ? report.timeline.filter((t) => !itemFilter || t.menuItemId === itemFilter.id) : []),
    [report, itemFilter],
  );
  const rangeOk = !!range.from && !!range.to && range.from <= range.to;
  const sum = report?.summary;
  const maxReason = report ? Math.max(1, ...report.reasons.map((r) => r.count)) : 1;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h2>Menu availability</h2>
          <p className={styles.sub}>
            When items were turned off, why, and for how long. Counts are the times an item was turned off in the period;
            downtime is the hours it was off during the period.
          </p>
        </div>
        <div className={styles.headActions}>
          <button
            className={styles.ghost}
            disabled={!report || report.items.length === 0}
            onClick={() =>
              report &&
              download(
                `menu-availability_${range.from}_to_${range.to}.csv`,
                ['Item', 'Category', 'Times turned off', 'Downtime hours', 'Longest off (hours)', 'Main reason', 'Still off', 'Est. lost units', 'Est. lost sales'],
                report.items.map((i) => [i.name, i.category ?? '', i.timesOff, i.downtimeHours, i.longestHours, i.topReason ?? '', i.stillOff ? 'Yes' : 'No', i.lostUnits, i.lostValue]),
              )
            }
          >
            Download items CSV
          </button>
          <button
            className={styles.ghost}
            disabled={!report || report.timeline.length === 0}
            onClick={() =>
              report &&
              download(
                `menu-off-log_${range.from}_to_${range.to}.csv`,
                ['Item', 'Category', 'Turned off', 'Turned on', 'Hours off', 'Reason', 'By', 'How'],
                report.timeline.map((t) => [t.name, t.category ?? '', fmtLocal(t.offAt), t.onAt ? fmtLocal(t.onAt) : 'still off', t.hours, t.reason, t.by ?? 'System', t.scope === 'category' ? 'Category switch' : 'Item']),
              )
            }
          >
            Download log CSV
          </button>
        </div>
      </div>

      <div className={styles.filters}>
        <PeriodPicker value={range} onChange={setRange} />
      </div>
      <div className={styles.range}>
        {rangeOk ? (range.from === range.to ? range.from : `${range.from} to ${range.to}`) : 'Pick a valid date range'}
      </div>
      {error && <div className={styles.error}>{error}</div>}

      {sum && (
        <div className={styles.tiles}>
          <div className={styles.tile}><span>Times turned off</span><b>{formatNumber(sum.offEvents)}</b></div>
          <div className={styles.tile}><span>Items affected</span><b>{formatNumber(sum.itemsAffected)}</b></div>
          <div className={styles.tile}><span>Total downtime</span><b>{fmtHours(sum.downtimeHours)}</b></div>
          <div className={styles.tile}><span>Category switches</span><b>{formatNumber(sum.categoryOffEvents)}</b></div>
          <div className={`${styles.tile} ${styles.tileKey}`} title="An estimate: what these items normally sell in the same hours, from the previous 4 weeks">
            <span>Est. lost sales</span>
            <b>{formatMoney(sum.lostValue)}</b>
            <small>about {formatNumber(Math.round(sum.lostUnits))} units</small>
          </div>
          <div className={styles.tile}><span>Off right now</span><b>{formatNumber(sum.currentlyOff)}</b></div>
        </div>
      )}

      {loading && !report ? (
        <div className={styles.empty}>Loading...</div>
      ) : report && report.items.length === 0 ? (
        <div className={styles.empty}>No item was turned off in this period.</div>
      ) : (
        report && (
          <>
            <section className={styles.card}>
              <h3>Items</h3>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Category</th>
                      <th className={styles.num}>Times off</th>
                      <th className={styles.num}>Downtime</th>
                      <th className={styles.num}>Longest</th>
                      <th>Main reason</th>
                      <th className={styles.num}>Est. lost units</th>
                      <th className={styles.num}>Est. lost sales</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.items.map((i) => (
                      <tr
                        key={i.menuItemId}
                        className={`${styles.clickRow} ${itemFilter?.id === i.menuItemId ? styles.rowOn : ''}`}
                        onClick={() => setItemFilter(itemFilter?.id === i.menuItemId ? null : { id: i.menuItemId, name: i.name })}
                        title="Click to see only this item in the log below"
                      >
                        <td>
                          <b>{i.name}</b>
                          {i.stillOff && <span className={styles.chipOff}>off now</span>}
                        </td>
                        <td>{i.category ?? '-'}</td>
                        <td className={styles.num}>{i.timesOff}</td>
                        <td className={`${styles.num} ${styles.strong}`}>{fmtHours(i.downtimeHours)}</td>
                        <td className={styles.num}>{fmtHours(i.longestHours)}</td>
                        <td>{i.topReason ?? '-'}</td>
                        <td className={styles.num}>{i.lostUnits ? formatNumber(Math.round(i.lostUnits)) : '-'}</td>
                        <td className={styles.num}>{i.lostValue ? formatMoney(i.lostValue) : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className={styles.note}>
                Est. lost sales = what the item normally sells in the same hours (same weekday, average of the previous 4 weeks)
                at the price it sold for. Hours when the outlet is closed add nothing. It is an estimate, not a measured loss.
              </p>
            </section>

            <div className={styles.twoCol}>
              <section className={styles.card}>
                <h3>Reasons</h3>
                {report.reasons.length === 0 ? (
                  <p className={styles.note}>No items were turned off in this period.</p>
                ) : (
                  report.reasons.map((r) => (
                    <div key={r.reason} className={styles.reasonRow}>
                      <div className={styles.reasonHead}>
                        <span>{r.reason}</span>
                        <span>{r.count} × · {fmtHours(r.downtimeHours)}</span>
                      </div>
                      <div className={styles.bar}><i style={{ width: `${(r.count / maxReason) * 100}%` }} /></div>
                    </div>
                  ))
                )}
              </section>
              <section className={styles.card}>
                <h3>When it happens</h3>
                <div className={styles.patternLabel}>By weekday</div>
                <Bars
                  data={report.byWeekday.map((d) => ({ key: DAYS[d.dow], value: d.count }))}
                  label={(k, v) => `${k}: ${v} time${v === 1 ? '' : 's'} turned off`}
                />
                <div className={styles.patternLabel}>By hour of the day</div>
                <Bars
                  data={report.byHour.map((d) => ({ key: String(d.hour), value: d.count }))}
                  label={(k, v) => `${k}:00: ${v} time${v === 1 ? '' : 's'} turned off`}
                />
              </section>
            </div>

            {report.categoryEvents.length > 0 && (
              <section className={styles.card}>
                <h3>Category switches</h3>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr><th>Category</th><th>Turned off</th><th className={styles.num}>Items</th><th className={styles.num}>Off for</th><th>Reason</th></tr>
                    </thead>
                    <tbody>
                      {report.categoryEvents.map((c, idx) => (
                        <tr key={idx}>
                          <td><b>{c.category}</b></td>
                          <td>{fmtLocal(c.offAt)}</td>
                          <td className={styles.num}>{c.itemCount}</td>
                          <td className={styles.num}>{fmtHours(c.downtimeHours)}{c.stillOff && <span className={styles.chipOff}>off now</span>}</td>
                          <td>{c.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {report.currentlyOff.length > 0 && (
              <section className={styles.card}>
                <h3>Off right now</h3>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr><th>Item</th><th>Category</th><th>Reason</th><th>Since</th><th>By</th></tr>
                    </thead>
                    <tbody>
                      {report.currentlyOff.map((c) => (
                        <tr key={c.menuItemId}>
                          <td><b>{c.name}</b></td>
                          <td>{c.category ?? '-'}</td>
                          <td>{c.reason ?? 'No reason recorded'}</td>
                          <td>{c.since ? formatDateTime(c.since) : '-'}</td>
                          <td>{c.by ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <section className={styles.card}>
              <h3>
                Log
                {itemFilter && (
                  <button className={styles.filterChip} onClick={() => setItemFilter(null)} title="Show all items">
                    {itemFilter.name} ×
                  </button>
                )}
              </h3>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr><th>Item</th><th>Turned off</th><th>Turned on</th><th className={styles.num}>Off for</th><th>Reason</th><th>By</th></tr>
                  </thead>
                  <tbody>
                    {timeline.map((t, idx) => (
                      <tr key={`${t.menuItemId}-${t.offAt}-${idx}`}>
                        <td>
                          <b>{t.name}</b>
                          {t.scope === 'category' && <span className={styles.chipCat}>category</span>}
                        </td>
                        <td>{fmtLocal(t.offAt)}</td>
                        <td>{t.onAt ? fmtLocal(t.onAt) : <span className={styles.chipOff}>still off</span>}</td>
                        <td className={styles.num}>{fmtHours(t.hours)}</td>
                        <td>{t.reason}</td>
                        <td>{t.by ?? 'System'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {report.timeline.length >= 500 && <p className={styles.note}>Showing the latest 500 entries.</p>}
            </section>

            <section className={styles.card}>
              <h3>Who turned items on and off</h3>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr><th>Person</th><th className={styles.num}>Turned off</th><th className={styles.num}>Turned on</th></tr>
                  </thead>
                  <tbody>
                    {report.staff.map((s) => (
                      <tr key={s.name}>
                        <td><b>{s.name}</b></td>
                        <td className={styles.num}>{s.offs}</td>
                        <td className={styles.num}>{s.ons}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )
      )}
    </div>
  );
}
