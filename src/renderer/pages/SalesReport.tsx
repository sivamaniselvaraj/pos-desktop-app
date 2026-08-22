import { useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import type { ReportBucket, SalesReportRow, TopItemRow } from '@shared/types';
import pageStyles from '../styles/Page.module.css';
import styles from '../styles/SalesReport.module.css';

type Mode = 'daily' | 'monthly' | 'custom';

function toIsoDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

function formatCurrency(n: number): string {
  return `₹ ${n.toFixed(2)}`;
}

function presetRange(mode: Mode): { from: string; to: string } {
  const today = new Date();
  if (mode === 'daily') {
    const from = new Date(today);
    from.setDate(from.getDate() - 13); // last 14 days, daily bars
    return { from: toIsoDate(from), to: toIsoDate(today) };
  }
  if (mode === 'monthly') {
    const from = new Date(today.getFullYear(), 0, 1); // Jan 1 this year, monthly bars
    return { from: toIsoDate(from), to: toIsoDate(today) };
  }
  // custom: default to the current month, user adjusts freely
  const from = new Date(today.getFullYear(), today.getMonth(), 1);
  return { from: toIsoDate(from), to: toIsoDate(today) };
}

// Which bucket to request from the RPC for the active mode/range. Daily and
// Monthly modes map directly; Custom auto-picks day vs month based on span so
// a long custom range stays readable.
function bucketFor(mode: Mode, from: string, to: string): ReportBucket {
  if (mode === 'monthly') return 'month';
  if (mode === 'daily') return 'day';
  const spanDays = (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000;
  return spanDays > 62 ? 'month' : 'day';
}

export function SalesReport() {
  const [mode, setMode] = useState<Mode>('daily');
  const [range, setRange] = useState(() => presetRange('daily'));
  const [rows, setRows] = useState<SalesReportRow[]>([]);
  const [topItems, setTopItems] = useState<TopItemRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function selectMode(next: Mode) {
    setMode(next);
    setRange(presetRange(next));
  }

  const bucket = bucketFor(mode, range.from, range.to);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      window.api.getSalesReport(range.from, range.to, bucket),
      window.api.getTopItems(range.from, range.to),
    ])
      .then(([reportRows, items]) => {
        if (cancelled) return;
        setRows(reportRows);
        setTopItems(items);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load sales report');
        setRows([]);
        setTopItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [range.from, range.to, bucket]);

  // Rows already arrive as one aggregate per bucket from the RPC — the
  // summary just sums/derives across buckets, no per-order data on the client.
  const summary = useMemo(() => {
    const orderCount = rows.reduce((sum, r) => sum + r.orderCount, 0);
    const netTotal = rows.reduce((sum, r) => sum + r.netTotal, 0);
    const taxTotal = rows.reduce((sum, r) => sum + r.taxTotal, 0);
    const avgOrderValue = orderCount > 0 ? netTotal / orderCount : 0;
    return { orderCount, netTotal, taxTotal, avgOrderValue };
  }, [rows]);

  const chartData = useMemo(
    () => rows.map((r) => ({ date: r.date, amount: r.netTotal })),
    [rows],
  );

  return (
    <div className={pageStyles.page}>
      <h2>Sales Report</h2>

      <div className={styles.filters}>
        <div className={styles.modeToggle}>
          {(['daily', 'monthly', 'custom'] as Mode[]).map((m) => (
            <button
              key={m}
              className={`${styles.modeBtn} ${mode === m ? styles.modeActive : ''}`}
              onClick={() => selectMode(m)}
            >
              {m === 'daily' ? 'Daily' : m === 'monthly' ? 'Monthly' : 'Custom'}
            </button>
          ))}
        </div>

        <div className={styles.dateRange}>
          <label>
            From
            <input
              type="date"
              value={range.from}
              max={range.to}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={range.to}
              min={range.from}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            />
          </label>
        </div>
      </div>

      {error && <p className={styles.error}>{error}</p>}
      {loading && <p className={pageStyles.muted}>Loading report…</p>}

      {!loading && !error && (
        <>
          <div className={styles.summaryGrid}>
            <div className={styles.summaryCard}>
              <div className={styles.summaryLabel}>Net Total</div>
              <div className={styles.summaryValue}>{formatCurrency(summary.netTotal)}</div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryLabel}>Tax</div>
              <div className={styles.summaryValue}>{formatCurrency(summary.taxTotal)}</div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryLabel}>Orders</div>
              <div className={styles.summaryValue}>{summary.orderCount}</div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryLabel}>Avg Order Value</div>
              <div className={styles.summaryValue}>{formatCurrency(summary.avgOrderValue)}</div>
            </div>
          </div>

          <div className={styles.chartCard}>
            {chartData.length === 0 ? (
              <p className={pageStyles.muted}>No settled orders in this range.</p>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis
                    label={{ value: 'Amount (₹)', angle: -90, position: 'insideLeft' }}
                    tickFormatter={(v: number) => v.toLocaleString('en-IN')}
                  />
                  <Tooltip formatter={(v) => formatCurrency(typeof v === 'number' ? v : Number(v ?? 0))} />
                  <Bar dataKey="amount" fill="#4CAF50" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          <h3 className={styles.subheading}>Top 10 Items (by quantity sold)</h3>
          {topItems.length === 0 ? (
            <p className={pageStyles.muted}>No item sales in this range.</p>
          ) : (
            <table className={pageStyles.table}>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Qty Sold</th>
                  <th>Revenue</th>
                </tr>
              </thead>
              <tbody>
                {topItems.map((item) => (
                  <tr key={item.menuItemId}>
                    <td>{item.name}</td>
                    <td>{item.quantitySold}</td>
                    <td>{formatCurrency(item.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
