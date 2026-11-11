import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { HourlySalesReport } from '@shared/reportTypes';
import { PeriodPicker } from '../../components/PeriodPicker';
import { presetRange } from '../../lib/dateRange';
import { formatMoney, formatNumber } from '../../lib/format';
import { downloadCsv, m2, type CsvCell } from '../../lib/reportCsv';
import styles from '../../styles/Reports.module.css';
import {
  brandColour,
  DOW_LONG,
  DOW_ORDER,
  DOW_SHORT,
  hourLabel,
  hourRange,
  pct1,
  rangeLabel,
  rangeOk,
  share,
  type DateRange,
} from './common';

type Metric = 'orders' | 'netSales' | 'itemsSold';
type Basis = 'perDay' | 'total';

const METRICS: { key: Metric; label: string }[] = [
  { key: 'orders', label: 'Orders' },
  { key: 'netSales', label: 'Net sales' },
  { key: 'itemsSold', label: 'Items' },
];

interface HourRow {
  hour: number;
  orders: number;
  netSales: number;
  total: number;
  itemsSold: number;
}

export function HourlySalesTab({ outletId }: { outletId: string }) {
  const [range, setRange] = useState<DateRange>(() => presetRange('thisMonth'));
  const [data, setData] = useState<HourlySalesReport | null>(null);
  const [metric, setMetric] = useState<Metric>('orders');
  const [basis, setBasis] = useState<Basis>('perDay');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rangeOk(range)) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.api
      .getSalesByHour(outletId, range.from, range.to)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (cancelled) return;
        setData(null);
        setError(err instanceof Error ? err.message : 'Could not load the report');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  const view = useMemo(() => {
    const cells = data?.cells ?? [];
    const daysOpen = (data?.days ?? []).reduce((a, d) => a + d.daysOpen, 0);
    const openByDow = new Map((data?.days ?? []).map((d) => [d.dow, d.daysOpen]));

    const hours: HourRow[] = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0, netSales: 0, total: 0, itemsSold: 0 }));
    for (const c of cells) {
      const h = hours[c.hour];
      h.orders += c.orders;
      h.netSales += c.netSales;
      h.total += c.total;
      h.itemsSold += c.itemsSold;
    }
    const busy = hours.filter((h) => h.orders > 0);
    const first = busy.length ? busy[0].hour : 0;
    const last = busy.length ? busy[busy.length - 1].hour : -1;
    const span = hours.slice(first, last + 1); // trading hours, including quiet ones in between

    const totals = hours.reduce(
      (t, h) => ({ orders: t.orders + h.orders, netSales: t.netSales + h.netSales, total: t.total + h.total, itemsSold: t.itemsSold + h.itemsSold }),
      { orders: 0, netSales: 0, total: 0, itemsSold: 0 },
    );

    const byDow = DOW_ORDER.map((dow) => {
      const list = cells.filter((c) => c.dow === dow);
      return {
        dow,
        daysOpen: openByDow.get(dow) ?? 0,
        orders: list.reduce((a, c) => a + c.orders, 0),
        netSales: list.reduce((a, c) => a + c.netSales, 0),
      };
    });

    const peaks = [...busy].sort((a, b) => b[metric] - a[metric]).slice(0, 3).map((h) => h.hour);
    const slow = span.length > 3 ? [...span].sort((a, b) => a[metric] - b[metric]).slice(0, 3).map((h) => h.hour) : [];
    const bestDow = [...byDow].filter((d) => d.daysOpen > 0).sort((a, b) => b.netSales / b.daysOpen - a.netSales / a.daysOpen)[0];
    return { hours, span, totals, daysOpen, byDow, peaks, slow, bestDow };
  }, [data, metric]);

  const maxHourShare = Math.max(1, ...view.span.map((h) => share(h.netSales, view.totals.netSales)));
  const per = (v: number): number => (basis === 'perDay' && view.daysOpen > 0 ? v / view.daysOpen : v);
  const fmt = (v: number): string => (metric === 'netSales' ? formatMoney(v) : basis === 'perDay' ? v.toFixed(1) : formatNumber(v));
  const peak = view.peaks.length ? view.hours[view.peaks[0]] : null;
  const brand = brandColour();
  const soft = brandColour('--brand-soft', '#e8f5e9');

  // Heatmap over weekday x hour, coloured by the chosen metric (average per trading day of that weekday when "per day").
  const heat = useMemo(() => {
    const cells = data?.cells ?? [];
    const openByDow = new Map((data?.days ?? []).map((d) => [d.dow, d.daysOpen]));
    const value = (dow: number, hour: number): number => {
      const c = cells.find((x) => x.dow === dow && x.hour === hour);
      if (!c) return 0;
      const v = c[metric];
      const n = openByDow.get(dow) ?? 0;
      return basis === 'perDay' && n > 0 ? v / n : v;
    };
    let max = 0;
    for (const dow of DOW_ORDER) for (const h of view.span) max = Math.max(max, value(dow, h.hour));
    return { value, max };
  }, [data, metric, basis, view.span]);

  function exportCsv() {
    const rows: CsvCell[][] = [
      ['Hourly sales'],
      ['Period', rangeLabel(range)],
      ['Trading days', view.daysOpen],
      [],
      ['Hour', 'Orders', 'Orders per trading day', 'Items', 'Net sales', 'Total', 'Average order', 'Share of net sales %'],
      ...view.span.map((h) => [
        hourRange(h.hour),
        h.orders,
        view.daysOpen ? (h.orders / view.daysOpen).toFixed(2) : '0',
        h.itemsSold,
        m2(h.netSales),
        m2(h.total),
        h.orders ? m2(h.total / h.orders) : '0.00',
        share(h.netSales, view.totals.netSales).toFixed(1),
      ]),
      [],
      ['Weekday', 'Hour', 'Orders', 'Items', 'Net sales', 'Total'],
      ...(data?.cells ?? []).map((c) => [DOW_LONG[c.dow], hourRange(c.hour), c.orders, c.itemsSold, m2(c.netSales), m2(c.total)]),
    ];
    downloadCsv(`hourly-sales_${range.from}_to_${range.to}.csv`, rows);
  }

  const hasData = view.totals.orders > 0;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h2>Hourly sales</h2>
          <p className={styles.sub}>
            When guests order: settled orders by the hour they were placed, to plan staff and prep for the peaks. “Per day” averages over the days that had at
            least one order.
          </p>
        </div>
        <div className={styles.actions}>
          <button className={styles.ghost} onClick={exportCsv} disabled={!hasData}>
            Download CSV
          </button>
        </div>
      </div>

      <div className={styles.filters}>
        <PeriodPicker value={range} onChange={setRange} initialPreset="thisMonth" />
        <div className={styles.seg} role="group" aria-label="Measure">
          {METRICS.map((x) => (
            <button key={x.key} className={metric === x.key ? styles.segOn : ''} onClick={() => setMetric(x.key)}>
              {x.label}
            </button>
          ))}
        </div>
        <div className={styles.seg} role="group" aria-label="Average or total">
          <button className={basis === 'perDay' ? styles.segOn : ''} onClick={() => setBasis('perDay')}>
            Per day
          </button>
          <button className={basis === 'total' ? styles.segOn : ''} onClick={() => setBasis('total')}>
            Total
          </button>
        </div>
      </div>

      <div className={styles.range}>
        {rangeLabel(range)}
        {hasData && ` · ${view.daysOpen} trading day${view.daysOpen === 1 ? '' : 's'}`}
      </div>
      {error && <div className={styles.error}>{error}</div>}

      {loading && !data ? (
        <div className={styles.empty}>Loading...</div>
      ) : !hasData ? (
        !error && <div className={styles.empty}>No settled orders in this period.</div>
      ) : (
        <>
          <div className={styles.tiles}>
            <div className={`${styles.tile} ${styles.tileKey}`}>
              <span>Peak hour</span>
              <b>{peak ? hourRange(peak.hour) : '-'}</b>
              {peak && (
                <small>
                  {fmt(per(peak[metric]))} {METRICS.find((x) => x.key === metric)?.label.toLowerCase()}
                  {basis === 'perDay' ? ' a day' : ''}
                </small>
              )}
            </div>
            <div className={`${styles.tile} ${styles.tileList}`}>
              <span>Other busy hours</span>
              <b>{view.peaks.slice(1).map(hourLabel).join(', ') || '-'}</b>
            </div>
            <div className={`${styles.tile} ${styles.tileList}`}>
              <span>Slowest hours (while open)</span>
              <b>{view.slow.map(hourLabel).join(', ') || '-'}</b>
            </div>
            <div className={styles.tile}>
              <span>Best weekday</span>
              <b>{view.bestDow ? DOW_LONG[view.bestDow.dow] : '-'}</b>
              {view.bestDow && <small>{formatMoney(view.bestDow.netSales / view.bestDow.daysOpen)} net a day</small>}
            </div>
            <div className={styles.tile}>
              <span>Orders per trading day</span>
              <b>{view.daysOpen ? (view.totals.orders / view.daysOpen).toFixed(1) : '0'}</b>
              <small>{formatMoney(view.daysOpen ? view.totals.netSales / view.daysOpen : 0)} net a day</small>
            </div>
          </div>

          <div className={styles.chartCard}>
            <div className={styles.chartHead}>
              <h3>
                {METRICS.find((x) => x.key === metric)?.label} by hour{basis === 'perDay' ? ' (average per trading day)' : ''}
              </h3>
              <div className={styles.legend}>
                <span>
                  <i style={{ background: brand }} />
                  Top 3 hours
                </span>
                <span>
                  <i style={{ background: soft, border: `1px solid ${brand}` }} />
                  Other hours
                </span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart
                data={view.span.map((h) => ({ hour: hourLabel(h.hour), h: h.hour, value: Number(per(h[metric]).toFixed(2)) }))}
                margin={{ top: 8, right: 16, left: 8, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="hour" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} width={56} tickFormatter={(v: number) => formatNumber(v)} />
                <Tooltip formatter={(v) => [fmt(Number(v)), METRICS.find((x) => x.key === metric)?.label ?? '']} />
                <Bar dataKey="value" radius={[4, 4, 0, 0]} stroke={brand}>
                  {view.span.map((h) => (
                    <Cell key={h.hour} fill={view.peaks.includes(h.hour) ? brand : soft} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className={`${styles.panel} ${styles.wide}`}>
            <h3>Weekday and hour</h3>
            <div style={{ overflowX: 'auto' }}>
              <table className={styles.heat}>
                <thead>
                  <tr>
                    <th />
                    {view.span.map((h) => (
                      <th key={h.hour}>{String(h.hour).padStart(2, '0')}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.byDow.map((d) => (
                    <tr key={d.dow}>
                      <th style={{ textAlign: 'left' }}>
                        {DOW_SHORT[d.dow]}
                        {d.daysOpen === 0 && <span className={styles.muted}> ·</span>}
                      </th>
                      {view.span.map((h) => {
                        const v = heat.value(d.dow, h.hour);
                        const a = heat.max > 0 ? v / heat.max : 0;
                        return (
                          <td key={h.hour} className={a > 0.55 ? styles.hot : undefined} title={`${DOW_LONG[d.dow]} ${hourRange(h.hour)}: ${fmt(v)}`}>
                            {v > 0 && <span className={styles.fill} style={{ opacity: 0.12 + a * 0.88 }} />}
                            <span className={styles.val}>
                              {v > 0 ? (metric === 'netSales' ? formatNumber(Math.round(v)) : Number.isInteger(v) ? v : v.toFixed(1)) : ''}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={styles.note}>Darker means busier. {basis === 'perDay' ? 'Each cell is the average for that weekday over the days it traded.' : 'Each cell is the total for the period.'}</p>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Hour</th>
                  <th className={styles.num}>Orders</th>
                  <th className={styles.num}>Per day</th>
                  <th className={styles.num}>Items</th>
                  <th className={styles.num}>Net sales</th>
                  <th className={styles.num}>Average order</th>
                  <th className={styles.num}>Share</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {view.span.map((h) => {
                  const sh = share(h.netSales, view.totals.netSales);
                  return (
                    <tr key={h.hour}>
                      <td className={view.peaks.includes(h.hour) ? styles.strong : undefined}>{hourRange(h.hour)}</td>
                      <td className={styles.num}>{h.orders}</td>
                      <td className={styles.num}>{view.daysOpen ? (h.orders / view.daysOpen).toFixed(1) : '0'}</td>
                      <td className={styles.num}>{formatNumber(h.itemsSold)}</td>
                      <td className={styles.num}>{formatMoney(h.netSales)}</td>
                      <td className={styles.num}>{h.orders ? formatMoney(h.total / h.orders) : '-'}</td>
                      <td className={styles.num}>{pct1(sh)}</td>
                      <td style={{ width: 140 }}>
                        <div className={styles.bar}>
                          <i style={{ width: `${(sh / maxHourShare) * 100}%` }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td>All hours</td>
                  <td className={styles.num}>{view.totals.orders}</td>
                  <td className={styles.num}>{view.daysOpen ? (view.totals.orders / view.daysOpen).toFixed(1) : '0'}</td>
                  <td className={styles.num}>{formatNumber(view.totals.itemsSold)}</td>
                  <td className={styles.num}>{formatMoney(view.totals.netSales)}</td>
                  <td className={styles.num}>{view.totals.orders ? formatMoney(view.totals.total / view.totals.orders) : '-'}</td>
                  <td className={styles.num}>100%</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
