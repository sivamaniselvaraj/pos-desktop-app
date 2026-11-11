import { useCallback, useEffect, useMemo, useState } from 'react';
import type { VoidEvent, VoidEventKind, VoidsDiscountsReport } from '@shared/reportTypes';
import base from '../../styles/SalesByWaiter.module.css';
import styles from '../../styles/VoidsDiscounts.module.css';
import { formatDateTime, formatMoney, formatNumber } from '../../lib/format';
import { presetRange } from '../../lib/dateRange';
import { PeriodPicker } from '../../components/PeriodPicker';

const KIND_LABEL: Record<VoidEventKind, string> = {
  item_removed: 'Item removed',
  qty_reduced: 'Quantity reduced',
  kitchen_cancelled: 'Cancelled in kitchen',
  order_cancelled: 'Order cancelled',
  discount: 'Discount',
  complimentary: 'Complimentary',
  discount_removed: 'Discount removed',
};
const KIND_CLASS: Record<VoidEventKind, string> = {
  item_removed: styles.kVoid,
  qty_reduced: styles.kVoid,
  kitchen_cancelled: styles.kKitchen,
  order_cancelled: styles.kCancel,
  discount: styles.kDiscount,
  complimentary: styles.kComp,
  discount_removed: styles.kRemoved,
};

type Filter = 'all' | 'voids' | 'cancels' | 'discounts';
const FILTER_KINDS: Record<Filter, VoidEventKind[] | null> = {
  all: null,
  voids: ['item_removed', 'qty_reduced', 'kitchen_cancelled'],
  cancels: ['order_cancelled'],
  discounts: ['discount', 'complimentary', 'discount_removed'],
};

function csvCell(v: string | number | null): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const orders = (n: number) => `${formatNumber(n)} ${n === 1 ? 'order' : 'orders'}`;

function orderLabel(e: VoidEvent): string {
  const where = e.orderType === 'dine-in' ? (e.tableNumber ? `Table ${e.tableNumber}` : 'Dine-in') : e.orderType === 'pickup' ? 'Takeaway' : e.orderType;
  return `#${e.orderNumber ?? '-'} · ${where}`;
}

/** Sales Report > Voids and discounts: every void, cancellation and discount, with who did it and why. */
export function VoidsDiscountsTab({ outletId }: { outletId: string }) {
  const [range, setRange] = useState(() => presetRange('today'));
  const [report, setReport] = useState<VoidsDiscountsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const load = useCallback(async (from: string, to: string) => {
    setLoading(true);
    setError(null);
    try {
      setReport(await window.api.getVoidsDiscounts(outletId, from, to));
    } catch (err) {
      setReport(null);
      setError(err instanceof Error ? err.message : 'Could not load the report');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (range.from && range.to && range.from <= range.to) void load(range.from, range.to);
  }, [range, load]);

  const events = useMemo(() => report?.events ?? [], [report]);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: events.length, voids: 0, cancels: 0, discounts: 0 };
    for (const e of events) {
      for (const f of ['voids', 'cancels', 'discounts'] as const) if (FILTER_KINDS[f]?.includes(e.kind)) c[f] += 1;
    }
    return c;
  }, [events]);
  const shown = useMemo(() => {
    const kinds = FILTER_KINDS[filter];
    const q = query.trim().toLowerCase();
    return events.filter((e) => {
      if (kinds && !kinds.includes(e.kind)) return false;
      if (!q) return true;
      return [e.by, e.approvedBy, e.item, e.reason, e.detail, e.invoiceNumber, e.tableNumber, String(e.orderNumber ?? '')]
        .some((v) => v != null && v.toLowerCase().includes(q));
    });
  }, [events, filter, query]);

  const s = report?.summary;
  const rangeOk = !!range.from && !!range.to && range.from <= range.to;

  function downloadCsv() {
    const head = ['Time', 'What', 'Order', 'Invoice', 'Table', 'Item', 'Qty', 'Value', 'Detail', 'Reason', 'Done by', 'Approved by', 'Order status now'];
    const lines = [head.map(csvCell).join(',')];
    for (const e of shown) {
      lines.push(
        [
          formatDateTime(e.at), KIND_LABEL[e.kind], e.orderNumber, e.invoiceNumber, e.tableNumber, e.item,
          e.qty, e.value.toFixed(2), e.detail, e.reason ?? 'No reason given', e.by, e.approvedBy, e.orderStatus,
        ]
          .map(csvCell)
          .join(','),
      );
    }
    const blob = new Blob([`${String.fromCharCode(0xfeff)}${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voids-and-discounts_${range.from}_to_${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const filterBtn = (f: Filter, label: string) => (
    <button
      key={f}
      type="button"
      className={`${styles.chip} ${filter === f ? styles.chipOn : ''}`}
      aria-pressed={filter === f}
      onClick={() => setFilter(f)}
    >
      {label}
      <small>{counts[f]}</small>
    </button>
  );

  return (
    <div className={base.page}>
      <div className={base.header}>
        <div>
          <h2>Voids and discounts</h2>
          <p className={base.sub}>
            Every item removed or reduced, KOT cancelled in the kitchen, order cancelled and discount given in this period, with who did it, who approved it and why.
          </p>
        </div>
        <button className={base.ghost} onClick={downloadCsv} disabled={shown.length === 0}>
          Download CSV
        </button>
      </div>

      <div className={base.filters}>
        <PeriodPicker value={range} onChange={setRange} />
      </div>
      <div className={base.range}>
        {rangeOk ? (range.from === range.to ? range.from : `${range.from} to ${range.to}`) : 'Pick a valid date range'}
      </div>
      {error && <div className={base.error}>{error}</div>}

      <div className={base.tiles}>
        <div className={base.tile}>
          <span>Items voided</span>
          <b>{formatMoney((s?.voidValue ?? 0) + (s?.kitchenCancelValue ?? 0))}</b>
          <span className={styles.tileSub}>
            {formatNumber(s?.voidCount ?? 0)} removed or reduced ({formatNumber(s?.voidQty ?? 0)} units)
            {s && s.kitchenCancelCount > 0 ? `, ${s.kitchenCancelCount} KOT cancelled` : ''}
          </span>
        </div>
        <div className={base.tile}>
          <span>Orders cancelled</span>
          <b>{formatMoney(s?.cancelledValue ?? 0)}</b>
          <span className={styles.tileSub}>{orders(s?.cancelledOrders ?? 0)}</span>
        </div>
        <div className={base.tile}>
          <span>Discounts</span>
          <b>{formatMoney(s?.discountValue ?? 0)}</b>
          <span className={styles.tileSub}>{orders(s?.discountOrders ?? 0)}</span>
        </div>
        <div className={base.tile}>
          <span>Complimentary</span>
          <b>{formatMoney(s?.complimentaryValue ?? 0)}</b>
          <span className={styles.tileSub}>{orders(s?.complimentaryOrders ?? 0)}</span>
        </div>
        <div className={base.tile}>
          <span>Without a reason</span>
          <b>{formatNumber(s?.noReason ?? 0)}</b>
          <span className={styles.tileSub}>of {formatNumber(s?.events ?? 0)} entries</span>
        </div>
      </div>

      {loading ? (
        <div className={base.empty}>Loading...</div>
      ) : events.length === 0 ? (
        <div className={base.empty}>No voids, cancellations or discounts in this period.</div>
      ) : (
        <>
          <div className={styles.twoCol}>
            <div>
              <h3 className={styles.sectionTitle}>By person</h3>
              <div className={base.tableWrap}>
                <table className={base.table}>
                  <thead>
                    <tr>
                      <th>Done by</th>
                      <th className={base.num}>Voids</th>
                      <th className={base.num}>Cancels</th>
                      <th className={base.num}>Discounts</th>
                      <th className={base.num}>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report?.staff ?? []).map((p) => (
                      <tr key={p.name}>
                        <td className={base.strong}>{p.name}</td>
                        <td className={base.num}>{p.voids}{p.voids > 0 && <small> {formatMoney(p.voidValue)}</small>}</td>
                        <td className={base.num}>{p.cancels}{p.cancels > 0 && <small> {formatMoney(p.cancelValue)}</small>}</td>
                        <td className={base.num}>{p.discounts}{p.discounts > 0 && <small> {formatMoney(p.discountValue)}</small>}</td>
                        <td className={`${base.num} ${base.strong}`}>{formatMoney(p.totalValue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <h3 className={styles.sectionTitle}>Top reasons</h3>
              <div className={base.tableWrap}>
                <table className={base.table}>
                  <thead>
                    <tr>
                      <th>Reason</th>
                      <th className={base.num}>Times</th>
                      <th className={base.num}>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report?.reasons ?? []).slice(0, 8).map((r) => (
                      <tr key={r.reason}>
                        <td className={r.reason === 'No reason given' ? styles.noReason : undefined}>{r.reason}</td>
                        <td className={base.num}>{r.count}</td>
                        <td className={base.num}>{formatMoney(r.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className={base.filters}>
            <div className={styles.chips}>
              {filterBtn('all', 'All')}
              {filterBtn('voids', 'Voids')}
              {filterBtn('cancels', 'Cancelled orders')}
              {filterBtn('discounts', 'Discounts')}
            </div>
            <input
              className={styles.search}
              placeholder="Find a person, item, reason or order #"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {shown.length === 0 ? (
            <div className={base.empty}>Nothing matches.</div>
          ) : (
            <div className={base.tableWrap}>
              <table className={`${base.table} ${styles.wrapTable}`}>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>What</th>
                    <th>Order</th>
                    <th>Item / detail</th>
                    <th className={base.num}>Value</th>
                    <th>Reason</th>
                    <th>Done by</th>
                    <th>Approved by</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((e) => (
                    <tr key={e.id}>
                      <td className={styles.when}>{formatDateTime(e.at)}</td>
                      <td><span className={`${styles.badge} ${KIND_CLASS[e.kind]}`}>{KIND_LABEL[e.kind]}</span></td>
                      <td>
                        <div>{orderLabel(e)}</div>
                        {e.invoiceNumber && <div className={styles.muted}>{e.invoiceNumber}</div>}
                      </td>
                      <td>
                        {e.item && (
                          <div>
                            {e.item}
                            {e.qty != null && e.kind !== 'kitchen_cancelled' && <span className={styles.muted}> · {formatNumber(e.qty)} voided</span>}
                          </div>
                        )}
                        {e.detail && <div className={styles.muted}>{e.detail}</div>}
                      </td>
                      <td className={`${base.num} ${base.strong}`}>{e.kind === 'discount_removed' ? '-' : formatMoney(e.value)}</td>
                      <td className={styles.reason}>
                        {e.reason ?? (e.kind === 'discount_removed' ? '' : <span className={styles.noReason}>No reason given</span>)}
                      </td>
                      <td>{e.by}</td>
                      <td>{e.approvedBy ?? <span className={styles.muted}>-</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
