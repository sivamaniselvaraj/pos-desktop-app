import { useEffect, useMemo, useState } from 'react';
import type { ProductMixItem, ProductMixReport } from '@shared/reportTypes';
import { PeriodPicker } from '../../components/PeriodPicker';
import { presetRange } from '../../lib/dateRange';
import { formatMoney, formatNumber } from '../../lib/format';
import { downloadCsv, m2, type CsvCell } from '../../lib/reportCsv';
import styles from '../../styles/Reports.module.css';
import { Delta, pct1, rangeLabel, rangeOk, share, type DateRange } from './common';

type Show = 'all' | 'top' | 'bottom' | 'unsold';
type SortKey = 'qty' | 'netSales' | 'change' | 'name';
/** A = the best sellers that make up the first 70% of item sales, B = the next 20%, C = the last 10%. */
type Grade = 'A' | 'B' | 'C' | '-';

const GRADE_TEXT: Record<Grade, string> = {
  A: 'Top seller',
  B: 'Steady',
  C: 'Slow',
  '-': 'Not sold',
};

interface Row extends ProductMixItem {
  qtyShare: number;
  salesShare: number;
  grade: Grade;
  rank: number;
}

function grade(rows: ProductMixItem[], total: number): Map<ProductMixItem, { grade: Grade; rank: number }> {
  const out = new Map<ProductMixItem, { grade: Grade; rank: number }>();
  const sorted = [...rows].sort((a, b) => b.netSales - a.netSales || b.qty - a.qty);
  let run = 0;
  sorted.forEach((r, i) => {
    if (r.qty <= 0) {
      out.set(r, { grade: '-', rank: i + 1 });
      return;
    }
    const before = total > 0 ? run / total : 1;
    run += r.netSales;
    out.set(r, { grade: before < 0.7 ? 'A' : before < 0.9 ? 'B' : 'C', rank: i + 1 });
  });
  return out;
}

const change = (r: ProductMixItem): number => (r.prevQty > 0 ? (r.qty - r.prevQty) / r.prevQty : r.qty > 0 ? Infinity : 0);

export function ProductMixTab() {
  const [range, setRange] = useState<DateRange>(() => presetRange('thisMonth'));
  const [data, setData] = useState<ProductMixReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState<Show>('all');
  const [sort, setSort] = useState<SortKey>('qty');
  const [category, setCategory] = useState('');
  const [find, setFind] = useState('');

  useEffect(() => {
    if (!rangeOk(range)) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.api
      .getProductMix(range.from, range.to)
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

  const all: Row[] = useMemo(() => {
    if (!data) return [];
    const g = grade(data.items, data.totals.netSales);
    return data.items.map((it) => ({
      ...it,
      qtyShare: share(it.qty, data.totals.qty),
      salesShare: share(it.netSales, data.totals.netSales),
      grade: g.get(it)?.grade ?? '-',
      rank: g.get(it)?.rank ?? 0,
    }));
  }, [data]);

  const categories = useMemo(() => [...new Set(all.map((r) => r.category))].sort((a, b) => a.localeCompare(b)), [all]);

  const rows = useMemo(() => {
    const q = find.trim().toLowerCase();
    let list = all.filter((r) => (!category || r.category === category) && (!q || r.name.toLowerCase().includes(q)));
    const bySales = (a: Row, b: Row) => b.netSales - a.netSales || b.qty - a.qty;
    if (show === 'top') list = [...list].filter((r) => r.qty > 0).sort(bySales).slice(0, 10);
    else if (show === 'bottom') list = [...list].filter((r) => r.qty > 0).sort((a, b) => -bySales(a, b)).slice(0, 10);
    else if (show === 'unsold') list = list.filter((r) => r.qty <= 0 && r.isActive);
    if (show === 'all' || show === 'unsold') {
      const cmp: Record<SortKey, (a: Row, b: Row) => number> = {
        qty: (a, b) => b.qty - a.qty || b.netSales - a.netSales,
        netSales: bySales,
        change: (a, b) => change(b) - change(a),
        name: (a, b) => a.name.localeCompare(b.name),
      };
      list = [...list].sort(cmp[sort]);
    }
    return list;
  }, [all, find, category, show, sort]);

  const sold = all.filter((r) => r.qty > 0);
  const unsold = all.filter((r) => r.qty <= 0 && r.isActive);
  const best = [...sold].sort((a, b) => b.qty - a.qty)[0];
  const earner = [...sold].sort((a, b) => b.netSales - a.netSales)[0];
  const t = data?.totals;
  const maxShare = Math.max(1, ...rows.map((r) => r.salesShare));

  function exportCsv() {
    if (!data) return;
    const out: CsvCell[][] = [
      ['Product mix'],
      ['Period', rangeLabel(range)],
      ['Compared with', `${data.totals.prevFrom} to ${data.totals.prevTo}`],
      [],
      ['Rank by sales', 'Item', 'Category', 'Active', 'Qty sold', 'Qty share %', 'Item sales (before tax)', 'Sales share %', 'Average price', 'Orders', 'Complimentary qty', 'Previous qty', 'Previous sales', 'Grade'],
      ...[...all]
        .sort((a, b) => a.rank - b.rank)
        .map((r) => [
          r.rank,
          r.name,
          r.category,
          r.isActive ? 'Yes' : 'No',
          r.qty,
          r.qtyShare.toFixed(1),
          m2(r.netSales),
          r.salesShare.toFixed(1),
          m2(r.avgPrice),
          r.orders,
          r.compQty,
          r.prevQty,
          m2(r.prevNetSales),
          GRADE_TEXT[r.grade],
        ]),
    ];
    downloadCsv(`product-mix_${range.from}_to_${range.to}.csv`, out);
  }

  const badge = (g: Grade) =>
    `${styles.badge} ${g === 'A' ? styles.badgeA : g === 'B' ? styles.badgeB : g === 'C' ? styles.badgeC : styles.badgeNone}`;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h2>Product mix</h2>
          <p className={styles.sub}>
            What each dish sold: units, item sales before tax and order discounts, its share, and the change against the period just before. Top sellers make up the
            first 70% of item sales, steady items the next 20%, slow items the last 10%.
          </p>
        </div>
        <div className={styles.actions}>
          <button className={styles.ghost} onClick={exportCsv} disabled={!data || all.length === 0}>
            Download CSV
          </button>
        </div>
      </div>

      <div className={styles.filters}>
        <PeriodPicker value={range} onChange={setRange} initialPreset="thisMonth" />
      </div>
      <div className={styles.filters}>
        <div className={styles.seg} role="group" aria-label="Show">
          {(
            [
              ['all', 'All items'],
              ['top', 'Top 10'],
              ['bottom', 'Bottom 10'],
              ['unsold', `Not sold (${unsold.length})`],
            ] as [Show, string][]
          ).map(([k, label]) => (
            <button key={k} className={show === k ? styles.segOn : ''} onClick={() => setShow(k)}>
              {label}
            </button>
          ))}
        </div>
        <label>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        {(show === 'all' || show === 'unsold') && (
          <label>
            Sort by
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="qty">Units sold</option>
              <option value="netSales">Item sales</option>
              <option value="change">Change</option>
              <option value="name">Name</option>
            </select>
          </label>
        )}
        <label>
          Find
          <input type="search" placeholder="Item name" value={find} onChange={(e) => setFind(e.target.value)} />
        </label>
      </div>

      <div className={styles.range}>
        {rangeLabel(range)}
        {t && ` · compared with ${t.prevFrom === t.prevTo ? t.prevFrom : `${t.prevFrom} to ${t.prevTo}`}`}
      </div>
      {error && <div className={styles.error}>{error}</div>}

      {loading && !data ? (
        <div className={styles.empty}>Loading...</div>
      ) : !data || !t ? null : (
        <>
          <div className={styles.tiles}>
            <div className={styles.tile}>
              <span>Units sold</span>
              <b>{formatNumber(t.qty)}</b>
              <Delta now={t.qty} before={t.prevQty} />
            </div>
            <div className={`${styles.tile} ${styles.tileKey}`}>
              <span>Item sales (before tax)</span>
              <b>{formatMoney(t.netSales)}</b>
              <Delta now={t.netSales} before={t.prevNetSales} />
            </div>
            <div className={styles.tile}>
              <span>Most units</span>
              <b title={best?.name}>{best ? best.name : '-'}</b>
              {best && <small>{formatNumber(best.qty)} sold</small>}
            </div>
            <div className={styles.tile}>
              <span>Highest earner</span>
              <b title={earner?.name}>{earner ? earner.name : '-'}</b>
              {earner && <small>{pct1(share(earner.netSales, t.netSales))} of item sales</small>}
            </div>
            <div className={styles.tile}>
              <span>Dishes sold</span>
              <b>{sold.length}</b>
              <small>{unsold.length} active dishes did not sell</small>
            </div>
          </div>

          {rows.length === 0 ? (
            <div className={styles.empty}>{show === 'unsold' ? 'Every active dish sold at least once.' : 'No items match.'}</div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Item</th>
                    <th className={styles.num}>Units</th>
                    <th className={styles.num}>Unit share</th>
                    <th className={styles.num}>Item sales</th>
                    <th className={styles.num}>Sales share</th>
                    <th />
                    <th className={styles.num}>Avg price</th>
                    <th className={styles.num}>Orders</th>
                    <th className={styles.num}>Change (units)</th>
                    <th>Grade</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.menuItemId ?? 'removed'}>
                      <td className={styles.muted}>{i + 1}</td>
                      <td>
                        <div className={styles.name}>
                          {r.name}
                          {!r.isActive && r.menuItemId && <span className={`${styles.badge} ${styles.badgeOff}`}>off menu</span>}
                        </div>
                        <div className={styles.cat}>{r.category}</div>
                      </td>
                      <td className={`${styles.num} ${styles.strong}`}>
                        {formatNumber(r.qty)}
                        {r.compQty > 0 && <div className={styles.cat}>{r.compQty} free</div>}
                      </td>
                      <td className={styles.num}>{pct1(r.qtyShare)}</td>
                      <td className={styles.num}>{formatMoney(r.netSales)}</td>
                      <td className={styles.num}>{pct1(r.salesShare)}</td>
                      <td style={{ width: 120 }}>
                        <div className={styles.bar}>
                          <i style={{ width: `${(r.salesShare / maxShare) * 100}%` }} />
                        </div>
                      </td>
                      <td className={styles.num}>{r.qty > 0 ? formatMoney(r.avgPrice) : '-'}</td>
                      <td className={styles.num}>{r.orders}</td>
                      <td className={styles.num}>
                        <Delta now={r.qty} before={r.prevQty} />
                        <div className={styles.cat}>before: {formatNumber(r.prevQty)}</div>
                      </td>
                      <td>
                        <span className={badge(r.grade)}>{GRADE_TEXT[r.grade]}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className={styles.note}>
            Item sales are the line values before tax and before order discounts, so they add up to more than the net sales on the Daily summary when discounts
            were given. Units on complimentary orders count as sold and are shown as “free”. Off-menu dishes appear only if they sold in either period.
          </p>
        </>
      )}
    </div>
  );
}
