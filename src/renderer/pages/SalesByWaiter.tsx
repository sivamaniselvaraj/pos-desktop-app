import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SalesByWaiterRow } from '@shared/types';
import styles from '../styles/SalesByWaiter.module.css';
import { formatMoney, dateInOrgZone, formatNumber } from '../lib/format';

type Preset = 'today' | 'yesterday' | 'thisMonth' | 'lastMonth' | 'custom';
const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'thisMonth', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
  { key: 'custom', label: 'Custom range' },
];

// Calendar arithmetic on YYYY-MM-DD strings (UTC), so it never shifts with the computer's time zone.
const parse = (s: string): Date => new Date(`${s}T00:00:00Z`);
const iso = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number): string => {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};

function presetRange(p: Exclude<Preset, 'custom'>): { from: string; to: string } {
  const today = dateInOrgZone(new Date());
  if (p === 'today') return { from: today, to: today };
  if (p === 'yesterday') {
    const y = addDays(today, -1);
    return { from: y, to: y };
  }
  const first = `${today.slice(0, 8)}01`;
  if (p === 'thisMonth') return { from: first, to: today };
  const lastDay = addDays(first, -1); // last month
  return { from: `${lastDay.slice(0, 8)}01`, to: lastDay };
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function SalesByWaiterTab() {
  const [preset, setPreset] = useState<Preset>('today');
  const [range, setRange] = useState(() => presetRange('today'));
  const [rows, setRows] = useState<SalesByWaiterRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (from: string, to: string) => {
    setLoading(true);
    setError(null);
    try {
      setRows(await window.api.getSalesByWaiter(from, to));
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : 'Could not load the report');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (range.from && range.to && range.from <= range.to) void load(range.from, range.to);
  }, [range, load]);

  function choose(p: Preset) {
    setPreset(p);
    if (p !== 'custom') setRange(presetRange(p));
  }

  const totals = useMemo(
    () =>
      rows.reduce(
        (t, r) => ({
          orders: t.orders + r.orderCount,
          items: t.items + r.itemsSold,
          excl: t.excl + r.salesExclTax,
          total: t.total + r.totalSales,
          discount: t.discount + r.discountTotal,
          tax: t.tax + r.taxTotal,
          eligible: t.eligible + r.eligibleSales,
          incentive: t.incentive + r.incentiveTotal,
        }),
        { orders: 0, items: 0, excl: 0, total: 0, discount: 0, tax: 0, eligible: 0, incentive: 0 },
      ),
    [rows],
  );
  const top = rows.length ? Math.max(...rows.map((r) => r.totalSales)) : 0;
  const rangeOk = !!range.from && !!range.to && range.from <= range.to;

  function downloadCsv() {
    const head = ['Rank', 'Waiter', 'Orders', 'Invoices', 'Items sold', 'Sales before tax', 'Discount', 'Tax', 'Total sales', 'Avg order', 'Incentive-eligible sales', 'Incentive'];
    const lines = [head.map(csvCell).join(',')];
    rows.forEach((r, i) => {
      const cells: (string | number)[] = [
        i + 1, r.waiterName, r.orderCount, r.invoiceCount, r.itemsSold,
        r.salesExclTax.toFixed(2), r.discountTotal.toFixed(2), r.taxTotal.toFixed(2),
        r.totalSales.toFixed(2), r.avgOrderValue.toFixed(2), r.eligibleSales.toFixed(2), r.incentiveTotal.toFixed(2),
      ];
      lines.push(cells.map(csvCell).join(','));
    });
    const blob = new Blob([`${String.fromCharCode(0xfeff)}${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sales-by-waiter_${range.from}_to_${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h2>Sales by waiter</h2>
          <p className={styles.sub}>
            Settled orders only, grouped by the waiter who placed them. Incentive comes from the rule set on each menu item (percentage of the item value before tax, or a fixed amount per unit).
          </p>
        </div>
        <button className={styles.ghost} onClick={downloadCsv} disabled={rows.length === 0}>
          Download CSV
        </button>
      </div>

      <div className={styles.filters}>
        <div className={styles.tabs}>
          {PRESETS.map((p) => (
            <button
              key={p.key}
              className={`${styles.tab} ${preset === p.key ? styles.tabOn : ''}`}
              onClick={() => choose(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className={styles.dates}>
            <label>
              From
              <input type="date" value={range.from} max={range.to || undefined} onChange={(e) => setRange({ ...range, from: e.target.value })} />
            </label>
            <label>
              To
              <input type="date" value={range.to} min={range.from || undefined} onChange={(e) => setRange({ ...range, to: e.target.value })} />
            </label>
          </div>
        )}
      </div>

      <div className={styles.range}>
        {rangeOk ? (range.from === range.to ? range.from : `${range.from} to ${range.to}`) : 'Pick a valid date range'}
      </div>
      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.tiles}>
        <div className={styles.tile}><span>Total sales</span><b>{formatMoney(totals.total)}</b></div>
        <div className={styles.tile}><span>Before tax</span><b>{formatMoney(totals.excl)}</b></div>
        <div className={styles.tile}><span>Orders</span><b>{formatNumber(totals.orders)}</b></div>
        <div className={styles.tile}><span>Waiters</span><b>{rows.length}</b></div>
        <div className={`${styles.tile} ${styles.tileKey}`}>
          <span>Incentive to pay</span>
          <b>{formatMoney(totals.incentive)}</b>
        </div>
      </div>

      {loading ? (
        <div className={styles.empty}>Loading...</div>
      ) : rows.length === 0 ? (
        <div className={styles.empty}>No settled orders in this period.</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>#</th>
                <th>Waiter</th>
                <th className={styles.num}>Orders</th>
                <th className={styles.num}>Items</th>
                <th className={styles.num}>Before tax</th>
                <th className={styles.num}>Discount</th>
                <th className={styles.num}>Tax</th>
                <th className={styles.num}>Total sales</th>
                <th className={styles.num}>Avg order</th>
                <th className={styles.num}>Eligible sales</th>
                <th className={styles.num}>Incentive</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.waiterId ?? 'none'}>
                  <td>{i + 1}</td>
                  <td>
                    <div className={styles.name}>{r.waiterName}</div>
                    <div className={styles.bar}><i style={{ width: `${top > 0 ? (r.totalSales / top) * 100 : 0}%` }} /></div>
                  </td>
                  <td className={styles.num}>
                    {r.orderCount}
                    {r.invoiceCount !== r.orderCount && <small> ({r.invoiceCount} bills)</small>}
                  </td>
                  <td className={styles.num}>{formatNumber(r.itemsSold)}</td>
                  <td className={styles.num}>{formatMoney(r.salesExclTax)}</td>
                  <td className={styles.num}>{formatMoney(r.discountTotal)}</td>
                  <td className={styles.num}>{formatMoney(r.taxTotal)}</td>
                  <td className={`${styles.num} ${styles.strong}`}>{formatMoney(r.totalSales)}</td>
                  <td className={styles.num}>{formatMoney(r.avgOrderValue)}</td>
                  <td className={styles.num}>{formatMoney(r.eligibleSales)}</td>
                  <td className={`${styles.num} ${styles.strong}`}>{formatMoney(r.incentiveTotal)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td />
                <td>All waiters</td>
                <td className={styles.num}>{totals.orders}</td>
                <td className={styles.num}>{formatNumber(totals.items)}</td>
                <td className={styles.num}>{formatMoney(totals.excl)}</td>
                <td className={styles.num}>{formatMoney(totals.discount)}</td>
                <td className={styles.num}>{formatMoney(totals.tax)}</td>
                <td className={styles.num}>{formatMoney(totals.total)}</td>
                <td />
                <td className={styles.num}>{formatMoney(totals.eligible)}</td>
                <td className={styles.num}>{formatMoney(totals.incentive)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
