import { memo } from 'react';
import type { TableCard } from '@shared/types';
import { Icon } from './Icon';
import { ElapsedMinutes } from '../lib/ElapsedMinutes';
import { formatMoney as formatCurrency, displayInvoiceNumber } from '../lib/format';
import styles from '../styles/TableDashboard.module.css';

function startedAt(createdAt: string | undefined): string {
  if (!createdAt) return '';
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function statusOf(t: TableCard): { key: string; label: string } {
  if (t.cardStatus === 'active') return { key: 'active', label: 'Ordered' };
  if (t.cardStatus === 'completed') {
    return t.paymentRecorded
      ? { key: 'settled', label: 'Paid' }
      : { key: 'settled', label: 'Unpaid' };
  }
  // if (t.manualStatus !== 'available') {
  //   return { key: 'manual_' + t.manualStatus, label: t.manualStatus };
  // }
  return { key: 'available', label: 'Available' };
}


/**
 * One Dashboard Dine-in tile (docs/DASHBOARD_TABLES.md). Memoized: every prop
 * is a plain value or a callback that never changes (useStableCallback in
 * Dashboard.tsx), and unchanged `table` objects are kept across reloads
 * (reuseUnchangedCards), so a live update re-renders only the tiles that changed.
 */
export interface TableCardViewProps {
  table: TableCard;
  /** Seats, from the Tables page (0 = not set). */
  capacity: number;
  /** The table has more than one bill: show "Bill NNNNN ·". */
  showBillNo: boolean;
  /** The table also has a Running bill (no New order button on its printed bill). */
  hasRunningBill: boolean;
  /** A print for this tile is in progress. */
  busy: boolean;
  /** orders.complete: may record a payment. */
  canRecordPayment: boolean;
  /** Undefined when the user may not place orders. */
  onAddItems?: (tableId: string) => void;
  onPrint: (table: TableCard) => void;
  onView: (table: TableCard) => void;
  onPay: (table: TableCard) => void;
}

export const TableCardView = memo(function TableCardView({
  table,
  capacity: cap,
  showBillNo,
  hasRunningBill,
  busy,
  canRecordPayment,
  onAddItems,
  onPrint,
  onView,
  onPay,
}: TableCardViewProps) {
  const st = statusOf(table);
  return (
    <div className={`${styles.card} ${styles[st.key] ?? ''}`}>
      <span className={styles.accent} />
      <div className={styles.cardTopRow}>
        <div className={styles.cardName}>{table.tableNumber}</div>
        {cap > 0 && (
          <div className={styles.seatDots} title={`${cap} seats`} aria-label={`${cap} seats`}>
            {Array.from({ length: Math.min(cap, 12) }, (_, i) => (
              <i
                key={i}
                className={`${styles.seat} ${table.cardStatus !== 'available' ? styles.seatTaken : ''}`}
              />
            ))}
            {cap > 12 && <span className={styles.seatMore}>+{cap - 12}</span>}
          </div>
        )}
      </div>
      <div className={styles.cardBottom}>
        <div className={styles.cardStatus}>{st.label}</div>
        {table.cardStatus !== 'available' && (
          <div className={styles.cardTime}>
            {showBillNo && table.invoiceNumber ? `Bill ${displayInvoiceNumber(table.invoiceNumber)} · ` : ''}
            {startedAt(table.orderCreatedAt)}
            <ElapsedMinutes createdAt={table.orderCreatedAt} />
          </div>
        )}
        {table.cardStatus !== 'available' && (
          <div className={styles.cardAmount}>{formatCurrency(table.orderTotalAmount ?? 0)}</div>
        )}
      </div>
      <div className={styles.cardActions}>
        {(table.cardStatus === 'available' || table.cardStatus === 'active') && (
          onAddItems && (
            <button
              className={styles.iconBtn}
              title="Add items (new order)"
              onClick={() => onAddItems(table.tableId)}
            >
              <Icon name="plus" size={16} />
            </button>
          )
        )}
         {table.cardStatus === 'active' && (
          <>
            <button
              className={styles.iconBtn}
              title="Complete and Print Bill"
              onClick={() => onPrint(table)}
              disabled={busy}
            >
              <Icon name="print" size={16} />
            </button>
            </>
            )}
          {table.cardStatus === 'active' && (
            <button
              className={styles.iconBtn}
              title="View details"
              onClick={() => onView(table)}
              disabled={busy}
            >
              <Icon name="view" size={16} />
            </button>
            )}
            {table.cardStatus === 'completed' && !hasRunningBill && onAddItems && (
              <button
                className={styles.iconBtn}
                title="New order (starts a new bill; this bill stays pending)"
                onClick={() => onAddItems(table.tableId)}
                disabled={busy}
              >
                <Icon name="plus" size={16} />
              </button>
            )}
            {table.cardStatus === 'completed' && !table.paymentRecorded && canRecordPayment && (
              <button
                className={styles.iconBtn}
                title="Record Payment (required to release this table)"
                onClick={() => onPay(table)}
                disabled={busy}
              >
                <Icon name="save" size={16} />
              </button>
            )}
      </div>
    </div>
  );
});
