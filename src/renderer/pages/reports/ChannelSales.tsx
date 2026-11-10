import { useEffect, useMemo, useState } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { ChannelSalesReport } from '@shared/reportTypes';
import { PeriodPicker } from '../../components/PeriodPicker';
import { presetRange } from '../../lib/dateRange';
import { formatMoney, formatNumber } from '../../lib/format';
import { downloadCsv, m2, type CsvCell } from '../../lib/reportCsv';
import styles from '../../styles/Reports.module.css';
import { brandColour, orderTypeLabel, pct1, rangeLabel, rangeOk, share, sourceLabel, type DateRange } from './common';

const TYPE_ORDER = ['dine-in', 'pickup', 'delivery'];
// Fixed series colours for the three dining options (the brand colour leads), like the Overview's order-type chart.
const typeColour = (t: string, brand: string): string => (t === 'dine-in' ? brand : t === 'pickup' ? '#2563eb' : t === 'delivery' ? '#f59e0b' : '#9ca3af');

export function ChannelSalesTab() {
  const [range, setRange] = useState<DateRange>(() => presetRange('thisMonth'));
  const [data, setData] = useState<ChannelSalesReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rangeOk(range)) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.api
      .getSalesByChannel(range.from, range.to)
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
    const ch = data?.channels ?? [];
    const types = [...new Set([...TYPE_ORDER, ...ch.map((c) => c.orderType)])]
      .map((t) => {
        const list = ch.filter((c) => c.orderType === t).sort((a, b) => a.orderSource.localeCompare(b.orderSource));
        const sum = (k: 'orders' | 'grossSales' | 'discounts' | 'netSales' | 'tax' | 'total') => list.reduce((a, c) => a + c[k], 0);
        return {
          orderType: t,
          sources: list,
          orders: sum('orders'),
          grossSales: sum('grossSales'),
          discounts: sum('discounts'),
          netSales: sum('netSales'),
          tax: sum('tax'),
          total: sum('total'),
        };
      })
      .filter((t) => t.orders > 0);
    const total = types.reduce((a, t) => a + t.total, 0);
    const net = types.reduce((a, t) => a + t.netSales, 0);
    const orders = types.reduce((a, t) => a + t.orders, 0);
    const mobile = ch.filter((c) => c.orderSource === 'mobile').reduce((a, c) => a + c.total, 0);
    const cats = data?.categories ?? [];
    const catTotal = cats.reduce((a, c) => a + c.netSales, 0);
    return { types, total, net, orders, mobile, cats, catTotal };
  }, [data]);

  const brand = brandColour();
  const maxCat = Math.max(1, ...view.cats.map((c) => c.netSales));

  function exportCsv() {
    const rows: CsvCell[][] = [
      ['Sales by channel and category'],
      ['Period', rangeLabel(range)],
      [],
      ['Dining option', 'Placed from', 'Orders', 'Gross sales', 'Discounts', 'Net sales', 'Tax', 'Total', 'Share of total %'],
      ...view.types.flatMap((t) =>
        t.sources.map((c) => [
          orderTypeLabel(t.orderType),
          sourceLabel(c.orderSource),
          c.orders,
          m2(c.grossSales),
          m2(c.discounts),
          m2(c.netSales),
          m2(c.tax),
          m2(c.total),
          share(c.total, view.total).toFixed(1),
        ]),
      ),
      [],
      ['Category', 'Units', 'Dishes', 'Orders', 'Item sales (before tax)', 'Share %'],
      ...view.cats.map((c) => [c.category, c.qty, c.items, c.orders, m2(c.netSales), share(c.netSales, view.catTotal).toFixed(1)]),
    ];
    downloadCsv(`sales-by-channel_${range.from}_to_${range.to}.csv`, rows);
  }

  const hasData = view.orders > 0;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h2>Channels and categories</h2>
          <p className={styles.sub}>
            Revenue by dining option (dine-in, takeaway, delivery) and where the order was placed (POS or a waiter&apos;s phone), and item sales by menu category.
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
      </div>
      <div className={styles.range}>{rangeLabel(range)}</div>
      {error && <div className={styles.error}>{error}</div>}

      {loading && !data ? (
        <div className={styles.empty}>Loading...</div>
      ) : !hasData ? (
        !error && <div className={styles.empty}>No settled orders in this period.</div>
      ) : (
        <>
          <div className={styles.tiles}>
            {view.types.map((t) => (
              <div className={styles.tile} key={t.orderType} style={{ borderTop: `3px solid ${typeColour(t.orderType, brand)}` }}>
                <span>{orderTypeLabel(t.orderType)}</span>
                <b>{formatMoney(t.total)}</b>
                <small>
                  {pct1(share(t.total, view.total))} · {formatNumber(t.orders)} orders · avg {formatMoney(t.orders ? t.total / t.orders : 0)}
                </small>
              </div>
            ))}
            <div className={styles.tile}>
              <span>Placed from phones</span>
              <b>{formatMoney(view.mobile)}</b>
              <small>{pct1(share(view.mobile, view.total))} of the total</small>
            </div>
          </div>

          <div className={`${styles.panel} ${styles.wide}`}>
            <h3>Share of revenue</h3>
            <div className={styles.pieRow}>
              <div style={{ width: 220, height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={view.types.map((t) => ({ name: orderTypeLabel(t.orderType), value: Number(t.total.toFixed(2)) }))}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={55}
                      outerRadius={90}
                      paddingAngle={2}
                      isAnimationActive={false}
                    >
                      {view.types.map((t) => (
                        <Cell key={t.orderType} fill={typeColour(t.orderType, brand)} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v) => formatMoney(Number(v))} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className={styles.pieLegend}>
                {view.types.map((t) => (
                  <div key={t.orderType}>
                    <i style={{ background: typeColour(t.orderType, brand) }} />
                    <span>{orderTypeLabel(t.orderType)}</span>
                    <b>{pct1(share(t.total, view.total))}</b>
                    <small>
                      {formatMoney(t.total)} · {formatNumber(t.orders)} orders
                    </small>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Dining option</th>
                  <th>Placed from</th>
                  <th className={styles.num}>Orders</th>
                  <th className={styles.num}>Gross sales</th>
                  <th className={styles.num}>Discounts</th>
                  <th className={styles.num}>Net sales</th>
                  <th className={styles.num}>Tax</th>
                  <th className={styles.num}>Total</th>
                  <th className={styles.num}>Share</th>
                </tr>
              </thead>
              {view.types.map((t) => (
                <tbody key={t.orderType}>
                  <tr className={styles.group}>
                    <td>{orderTypeLabel(t.orderType)}</td>
                    <td />
                    <td className={styles.num}>{t.orders}</td>
                    <td className={styles.num}>{formatMoney(t.grossSales)}</td>
                    <td className={styles.num}>{formatMoney(t.discounts)}</td>
                    <td className={styles.num}>{formatMoney(t.netSales)}</td>
                    <td className={styles.num}>{formatMoney(t.tax)}</td>
                    <td className={styles.num}>{formatMoney(t.total)}</td>
                    <td className={styles.num}>{pct1(share(t.total, view.total))}</td>
                  </tr>
                  {t.sources.map((c) => (
                    <tr key={c.orderSource}>
                      <td />
                      <td>{sourceLabel(c.orderSource)}</td>
                      <td className={styles.num}>{c.orders}</td>
                      <td className={styles.num}>{formatMoney(c.grossSales)}</td>
                      <td className={styles.num}>{formatMoney(c.discounts)}</td>
                      <td className={styles.num}>{formatMoney(c.netSales)}</td>
                      <td className={styles.num}>{formatMoney(c.tax)}</td>
                      <td className={styles.num}>{formatMoney(c.total)}</td>
                      <td className={styles.num}>{pct1(share(c.total, view.total))}</td>
                    </tr>
                  ))}
                </tbody>
              ))}
              <tfoot>
                <tr>
                  <td>All</td>
                  <td />
                  <td className={styles.num}>{view.orders}</td>
                  <td className={styles.num}>{formatMoney(view.types.reduce((a, t) => a + t.grossSales, 0))}</td>
                  <td className={styles.num}>{formatMoney(view.types.reduce((a, t) => a + t.discounts, 0))}</td>
                  <td className={styles.num}>{formatMoney(view.net)}</td>
                  <td className={styles.num}>{formatMoney(view.types.reduce((a, t) => a + t.tax, 0))}</td>
                  <td className={styles.num}>{formatMoney(view.total)}</td>
                  <td className={styles.num}>100%</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p className={styles.note} style={{ margin: '-8px 0 18px' }}>
            Delivery apps: orders from Swiggy, Zomato and other apps are not told apart yet. They count under the dining option they were entered as (usually
            Delivery). Separate delivery channels are planned in the Version 2 plan.
          </p>

          <h3 style={{ margin: '0 0 10px', fontSize: 16 }}>By category</h3>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Category</th>
                  <th className={styles.num}>Units</th>
                  <th className={styles.num}>Dishes</th>
                  <th className={styles.num}>Orders</th>
                  <th className={styles.num}>Item sales</th>
                  <th className={styles.num}>Share</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {view.cats.map((c) => (
                  <tr key={c.categoryId ?? c.category}>
                    <td className={styles.name}>{c.category}</td>
                    <td className={styles.num}>{formatNumber(c.qty)}</td>
                    <td className={styles.num}>{c.items}</td>
                    <td className={styles.num}>{c.orders}</td>
                    <td className={`${styles.num} ${styles.strong}`}>{formatMoney(c.netSales)}</td>
                    <td className={styles.num}>{pct1(share(c.netSales, view.catTotal))}</td>
                    <td style={{ width: 160 }}>
                      <div className={styles.bar}>
                        <i style={{ width: `${(c.netSales / maxCat) * 100}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>All categories</td>
                  <td className={styles.num}>{formatNumber(view.cats.reduce((a, c) => a + c.qty, 0))}</td>
                  <td className={styles.num}>{view.cats.reduce((a, c) => a + c.items, 0)}</td>
                  <td />
                  <td className={styles.num}>{formatMoney(view.catTotal)}</td>
                  <td className={styles.num}>100%</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          <p className={styles.note}>
            Category figures are item values before tax and before order discounts, so they can add up to more than the net sales above. Food and drink are told
            apart by the categories you set up in Menu items.
          </p>
        </>
      )}
    </div>
  );
}
