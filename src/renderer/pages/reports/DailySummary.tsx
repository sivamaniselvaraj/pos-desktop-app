import { useEffect, useMemo, useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DailySummaryReport, ShiftWindow } from '@shared/reportTypes';
import { PeriodPicker } from '../../components/PeriodPicker';
import { presetRange } from '../../lib/dateRange';
import { formatMoney, formatNumber, currencySymbol, taxLabel } from '../../lib/format';
import { downloadCsv, m2, type CsvCell } from '../../lib/reportCsv';
import styles from '../../styles/Reports.module.css';
import {
  brandColour,
  Delta,
  orderTypeLabel,
  paymentLabel,
  previousRange,
  rangeLabel,
  rangeOk,
  share,
  pct1,
  type DateRange,
} from './common';

type ShiftMode = 'day' | 'shift';

/** "2026-11-08T13:05:00" (outlet-local, from the database) -> "13:05". */
const clock = (v: string | null): string => (v ? v.slice(11, 16) : '-');
/** "2026-11-08 13:05" for a range of several days. */
const stamp = (v: string | null): string => (v ? v.slice(0, 16).replace('T', ' ') : '-');
const plural = (n: number, word: string): string => `${formatNumber(n)} ${word}${n === 1 ? '' : 's'}`;

function taxLineLabel(l: { name: string; rate: number | null }): string {
  return l.rate == null ? l.name : `${l.name} ${Number.isInteger(l.rate) ? l.rate : l.rate.toFixed(2)}%`;
}

export function DailySummaryTab() {
  const [range, setRange] = useState<DateRange>(() => presetRange('today'));
  const [shiftMode, setShiftMode] = useState<ShiftMode>('day');
  const [shift, setShift] = useState<ShiftWindow>({ start: '11:00', end: '16:00' });
  const [data, setData] = useState<DailySummaryReport | null>(null);
  const [prev, setPrev] = useState<DailySummaryReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shiftOk = shiftMode === 'day' || (!!shift.start && !!shift.end && shift.start !== shift.end);
  const activeShift = shiftMode === 'shift' && shiftOk ? shift : null;
  const before = previousRange(range);

  useEffect(() => {
    if (!rangeOk(range) || !shiftOk) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const p = previousRange(range);
    Promise.all([
      window.api.getDailySummary(range.from, range.to, activeShift),
      window.api.getDailySummary(p.from, p.to, activeShift),
    ])
      .then(([cur, old]) => {
        if (cancelled) return;
        setData(cur);
        setPrev(old);
      })
      .catch((err) => {
        if (cancelled) return;
        setData(null);
        setPrev(null);
        setError(err instanceof Error ? err.message : 'Could not load the report');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // activeShift is rebuilt every render; its fields are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, shiftMode, shift.start, shift.end, shiftOk]);

  const s = data?.summary;
  const p = prev?.summary;
  const multiDay = (data?.days.length ?? 0) > 1;
  const chartData = useMemo(
    () => (data?.days ?? []).map((d) => ({ date: d.date.slice(5), netSales: d.netSales, orders: d.orders })),
    [data],
  );

  function exportCsv() {
    if (!data || !s) return;
    const shiftText = activeShift ? `${activeShift.start} to ${activeShift.end}` : 'Whole day';
    const rows: CsvCell[][] = [
      ['Daily summary (Z-report)'],
      ['Period', rangeLabel(range)],
      ['Shift', shiftText],
      [],
      ['Line', 'Amount'],
      ['Gross sales', m2(s.grossSales)],
      ['Discounts', m2(-s.discounts)],
      ['Complimentary', m2(-s.complimentary)],
      ['Net sales', m2(s.netSales)],
      [`Tax (${taxLabel()})`, m2(s.tax)],
      ['Total collected', m2(s.total)],
      ['Container charges (in net sales)', m2(s.containerCharges)],
      [],
      ['Orders', s.orders],
      ['Bills', s.invoices],
      ['Items sold', s.itemsSold],
      ['Average order', m2(s.avgOrderValue)],
      ['Average bill', m2(s.avgBillValue)],
      ['Discounted orders', s.discountOrders],
      ['Complimentary orders', s.complimentaryOrders],
      ['Cancelled orders', s.cancelledOrders],
      ['Cancelled value', m2(s.cancelledValue)],
      ['First order', clock(s.firstOrderAt)],
      ['Last order', clock(s.lastOrderAt)],
      [],
      ['Tax', 'Taxable', 'Tax'],
      ...data.taxLines.map((l) => [taxLineLabel(l), m2(l.taxable), m2(l.tax)]),
      [],
      ['Payment', 'Orders', 'Amount'],
      ...data.payments.map((x) => [paymentLabel(x.method), x.orders, m2(x.amount)]),
      [],
      ['Order type', 'Orders', 'Net sales', 'Total'],
      ...data.orderTypes.map((t) => [orderTypeLabel(t.orderType), t.orders, m2(t.netSales), m2(t.total)]),
      [],
      ['Date', 'Orders', 'Gross sales', 'Discounts', 'Net sales', 'Tax', 'Total'],
      ...data.days.map((d) => [d.date, d.orders, m2(d.grossSales), m2(d.discounts), m2(d.netSales), m2(d.tax), m2(d.total)]),
    ];
    downloadCsv(`daily-summary_${range.from}_to_${range.to}.csv`, rows);
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h2>Daily summary (Z-report)</h2>
          <p className={styles.sub}>
            Settled orders for a day, a date range or one shift: gross and net sales, discounts, tax collected and how it was paid. The change is against the
            period of the same length just before ({rangeOk(before) ? rangeLabel(before) : '-'}).
          </p>
        </div>
        <div className={styles.actions}>
          <button className={styles.ghost} onClick={exportCsv} disabled={!s || s.orders === 0}>
            Download CSV
          </button>
        </div>
      </div>

      <div className={styles.filters}>
        <PeriodPicker value={range} onChange={setRange} />
        <div className={styles.inline}>
          <div className={styles.seg} role="group" aria-label="Shift">
            <button className={shiftMode === 'day' ? styles.segOn : ''} onClick={() => setShiftMode('day')}>
              Whole day
            </button>
            <button className={shiftMode === 'shift' ? styles.segOn : ''} onClick={() => setShiftMode('shift')}>
              One shift
            </button>
          </div>
          {shiftMode === 'shift' && (
            <>
              <label>
                From
                <input type="time" value={shift.start} onChange={(e) => setShift((x) => ({ ...x, start: e.target.value }))} />
              </label>
              <label>
                To
                <input type="time" value={shift.end} onChange={(e) => setShift((x) => ({ ...x, end: e.target.value }))} />
              </label>
            </>
          )}
        </div>
      </div>

      <div className={styles.range}>
        {rangeLabel(range)}
        {range.to >= presetRange('today').to && ' · the period is not over yet, so the change compares part of it with a full earlier period'}
        {activeShift && ` · orders placed ${activeShift.start} to ${activeShift.end}${activeShift.end < activeShift.start ? ' (runs past midnight)' : ''}`}
        {!shiftOk && ' · give a start and end time that differ'}
      </div>
      {error && <div className={styles.error}>{error}</div>}

      {loading && !s ? (
        <div className={styles.empty}>Loading...</div>
      ) : !s ? null : s.orders === 0 && s.cancelledOrders === 0 ? (
        <div className={styles.empty}>No settled orders in this period.</div>
      ) : (
        <>
          <div className={styles.tiles}>
            <div className={styles.tile}>
              <span>Gross sales</span>
              <b>{formatMoney(s.grossSales)}</b>
              {p && <Delta now={s.grossSales} before={p.grossSales} />}
            </div>
            <div className={styles.tile}>
              <span>Discounts and complimentary</span>
              <b>{formatMoney(s.discounts + s.complimentary)}</b>
              <small>{pct1(share(s.discounts + s.complimentary, s.grossSales))} of gross</small>
            </div>
            <div className={styles.tile}>
              <span>Net sales (before tax)</span>
              <b>{formatMoney(s.netSales)}</b>
              {p && <Delta now={s.netSales} before={p.netSales} />}
            </div>
            <div className={styles.tile}>
              <span>Tax collected</span>
              <b>{formatMoney(s.tax)}</b>
              {p && <Delta now={s.tax} before={p.tax} />}
            </div>
            <div className={`${styles.tile} ${styles.tileKey}`}>
              <span>Total collected</span>
              <b>{formatMoney(s.total)}</b>
              {p && <Delta now={s.total} before={p.total} />}
            </div>
            <div className={styles.tile}>
              <span>Orders</span>
              <b>{formatNumber(s.orders)}</b>
              {p && <Delta now={s.orders} before={p.orders} />}
              <small>
                {plural(s.invoices, 'bill')} · avg {formatMoney(s.avgBillValue)}
              </small>
            </div>
          </div>

          <div className={styles.grid2}>
            <div className={styles.panel}>
              <h3>Sales</h3>
              <table className={styles.stmt}>
                <tbody>
                  <tr className={styles.sum}>
                    <td>Gross sales</td>
                    <td>{formatMoney(s.grossSales)}</td>
                  </tr>
                  <tr className={styles.minus}>
                    <td>Discounts ({plural(s.discountOrders, 'order')})</td>
                    <td>- {formatMoney(s.discounts)}</td>
                  </tr>
                  <tr className={styles.minus}>
                    <td>Complimentary ({plural(s.complimentaryOrders, 'order')})</td>
                    <td>- {formatMoney(s.complimentary)}</td>
                  </tr>
                  <tr className={styles.sum}>
                    <td>Net sales</td>
                    <td>{formatMoney(s.netSales)}</td>
                  </tr>
                  <tr className={styles.minus}>
                    <td>Tax ({taxLabel()})</td>
                    <td>+ {formatMoney(s.tax)}</td>
                  </tr>
                  <tr className={styles.total}>
                    <td>Total collected</td>
                    <td>{formatMoney(s.total)}</td>
                  </tr>
                </tbody>
              </table>
              <p className={styles.note}>
                {s.containerCharges > 0 && `Net sales include ${formatMoney(s.containerCharges)} of container charges. `}
                Cancelled: {plural(s.cancelledOrders, 'order')} worth {formatMoney(s.cancelledValue)} (not in the sales). {plural(s.itemsSold, 'item')} sold.
                First order {multiDay ? stamp(s.firstOrderAt) : clock(s.firstOrderAt)}, last order{' '}
                {multiDay ? stamp(s.lastOrderAt) : clock(s.lastOrderAt)}.
              </p>
            </div>

            <div className={styles.panel}>
              <h3>Payments</h3>
              {data.payments.length === 0 ? (
                <p className={styles.muted}>No payments.</p>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th className={styles.num}>Orders</th>
                      <th className={styles.num}>Amount</th>
                      <th className={styles.num}>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.payments.map((x) => (
                      <tr key={x.method}>
                        <td className={x.method === 'unpaid' ? styles.muted : undefined}>{paymentLabel(x.method)}</td>
                        <td className={styles.num}>{x.orders}</td>
                        <td className={styles.num}>{formatMoney(x.amount)}</td>
                        <td className={styles.num}>{pct1(share(x.amount, s.total))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className={styles.note}>A part payment is shared between cash, card and UPI by the amounts entered. “Not recorded” is settled orders with no payment saved yet.</p>
            </div>

            <div className={styles.panel}>
              <h3>Tax collected</h3>
              {data.taxLines.length === 0 ? (
                <p className={styles.muted}>No tax in this period.</p>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Rate</th>
                      <th className={styles.num}>Taxable value</th>
                      <th className={styles.num}>Tax</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.taxLines.map((l) => (
                      <tr key={`${l.name}|${l.rate}`}>
                        <td>{taxLineLabel(l)}</td>
                        <td className={styles.num}>{formatMoney(l.taxable)}</td>
                        <td className={styles.num}>{formatMoney(l.tax)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Total</td>
                      <td className={styles.num}>{formatMoney(data.taxLines.reduce((a, l) => a + l.taxable, 0))}</td>
                      <td className={styles.num}>{formatMoney(s.tax)}</td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>

            <div className={styles.panel}>
              <h3>By order type</h3>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th className={styles.num}>Orders</th>
                    <th className={styles.num}>Total</th>
                    <th className={styles.num}>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {data.orderTypes.map((t) => (
                    <tr key={t.orderType}>
                      <td>{orderTypeLabel(t.orderType)}</td>
                      <td className={styles.num}>{t.orders}</td>
                      <td className={styles.num}>{formatMoney(t.total)}</td>
                      <td className={styles.num}>{pct1(share(t.total, s.total))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {multiDay && (
            <>
              <div className={styles.chartCard}>
                <h3>Net sales by day</h3>
                <ResponsiveContainer width="100%" height={240}>
                  <ComposedChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="money" tickFormatter={(v: number) => formatNumber(v)} tick={{ fontSize: 11 }} width={64} />
                    <YAxis yAxisId="orders" orientation="right" allowDecimals={false} tick={{ fontSize: 11 }} width={36} />
                    <Tooltip
                      formatter={(v, name) => (name === 'Orders' ? [String(v), 'Orders'] : [`${currencySymbol()} ${Number(v).toFixed(2)}`, String(name)])}
                    />
                    <Bar yAxisId="money" dataKey="netSales" name="Net sales" fill={brandColour()} radius={[4, 4, 0, 0]} />
                    <Line yAxisId="orders" dataKey="orders" name="Orders" stroke="#374151" strokeWidth={2} dot={{ r: 2 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th className={styles.num}>Orders</th>
                      <th className={styles.num}>Gross sales</th>
                      <th className={styles.num}>Discounts</th>
                      <th className={styles.num}>Net sales</th>
                      <th className={styles.num}>Tax</th>
                      <th className={styles.num}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.days.map((d) => (
                      <tr key={d.date}>
                        <td>{d.date}</td>
                        <td className={styles.num}>{d.orders}</td>
                        <td className={styles.num}>{formatMoney(d.grossSales)}</td>
                        <td className={styles.num}>{formatMoney(d.discounts)}</td>
                        <td className={styles.num}>{formatMoney(d.netSales)}</td>
                        <td className={styles.num}>{formatMoney(d.tax)}</td>
                        <td className={`${styles.num} ${styles.strong}`}>{formatMoney(d.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Total</td>
                      <td className={styles.num}>{s.orders}</td>
                      <td className={styles.num}>{formatMoney(s.grossSales)}</td>
                      <td className={styles.num}>{formatMoney(s.discounts + s.complimentary)}</td>
                      <td className={styles.num}>{formatMoney(s.netSales)}</td>
                      <td className={styles.num}>{formatMoney(s.tax)}</td>
                      <td className={styles.num}>{formatMoney(s.total)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
