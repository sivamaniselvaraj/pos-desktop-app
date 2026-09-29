import { Fragment, useState } from 'react';
import type { OrderDetailItem, OrderActivityLogEntry } from '@shared/types';
import styles from '../styles/OrderDetailModal.module.css';

function formatCurrency(n: number): string {
  return `₹ ${n.toFixed(2)}`;
}

function statusLabel(status: string): string {
  if (status === 'open') return 'Active';
  if (status === 'completed') return 'Completed';
  if (status === 'cancelled') return 'Cancelled';
  return status;
}

function statusClass(status: string): string {
  if (status === 'open') return styles.statusActive;
  if (status === 'completed') return styles.statusCompleted;
  if (status === 'cancelled') return styles.statusCancelled;
  return '';
}

/** Optional "Type: X · Invoice No.: Y · [status badge]" line + the locked-order notice, shown only when passed. */
export interface OrderDetailModalMeta {
  orderType: string;
  status: string;
  invoiceNumber?: string;
  date: string;
}

/** Optional subtotal/tax/container-charge/discount/grand-total breakdown, shown only when passed. */
export interface OrderDetailModalTotals {
  subtotalAmount: number;
  taxAmount: number;
  containerChargeAmount: number;
  discountAmount: number;
  totalAmount: number;
  orderType: string;
}

export interface OrderDetailModalProps {
  /** Heading, e.g. "Table T4" or "Order a1b2c3d4". */
  title: string;
  /** Shown after " · " next to the title, e.g. the order/batch grand total. */
  headerAmount?: number;
  /** Every order (round) in this batch. Length > 1 shows the "Orders: #, #, …" line and Order # group headers/columns; length <= 1 hides all of that grouping UI. */
  orders: { id: string; orderNumber: number }[];
  meta?: OrderDetailModalMeta;
  totals?: OrderDetailModalTotals;
  items: OrderDetailItem[];
  log: OrderActivityLogEntry[];
  loading: boolean;
  /** Whether the Edit/Remove actions render at all — false for a locked (completed/cancelled) order. */
  editable: boolean;
  onClose: () => void;
  /** Persist the edit (call the editOrderItem IPC, reload, refresh the caller's own list) — quantity/reason are already validated non-empty/positive by this component before it's called. */
  onEditItem: (orderItemId: string, quantity: number, reason: string) => Promise<void>;
  /** Persist the removal (call deleteOrderItem, reload, refresh) — reason is already collected and validated non-empty by this component before it's called. */
  onDeleteItem: (item: OrderDetailItem, reason: string) => Promise<void>;
  /** Surface a validation message the same way the caller's own page does (e.g. its flash() banner). */
  onMessage: (type: 'success' | 'error', text: string) => void;
}

/**
 * OrderDetailModal
 * ---------------------------------------------------------------------------
 * The "view items / edit / remove / activity log" modal shared by the Table
 * Dashboard's "View Items" and the Orders List page's "View / Edit Items" —
 * previously two separately-maintained copies of nearly the same JSX. Pure
 * presentation + light client-side validation; every actual read/write goes
 * through the caller's own IPC calls via onEditItem/onDeleteItem, so this
 * component has no knowledge of window.api, table batches, or order lists.
 *
 * meta/totals are optional specifically because not every caller has that
 * data on hand — e.g. the Table Dashboard's TableCard doesn't currently
 * carry subtotal/tax/orderType/invoiceNumber (only Orders List's
 * OrderListRow does), so passing them is opt-in per caller rather than a
 * hard requirement of this component.
 * ---------------------------------------------------------------------------
 */
export function OrderDetailModal({
  title,
  headerAmount,
  orders,
  meta,
  totals,
  items,
  log,
  loading,
  editable,
  onClose,
  onEditItem,
  onDeleteItem,
  onMessage,
}: OrderDetailModalProps) {
  const [editing, setEditing] = useState<{ id: string; quantity: string; reason: string } | null>(
    null,
  );
  const grouped = orders.length > 1;

  function startEdit(item: OrderDetailItem) {
    setEditing({ id: item.orderItemId, quantity: String(item.quantity), reason: '' });
  }

  async function submitEdit() {
    if (!editing) return;
    const quantity = Number(editing.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      onMessage('error', 'Quantity must be a positive number');
      return;
    }
    const reason = editing.reason.trim();
    if (!reason) {
      onMessage('error', 'A reason is required to edit an item');
      return;
    }
    await onEditItem(editing.id, quantity, reason);
    setEditing(null);
  }

  async function submitDelete(item: OrderDetailItem) {
    const raw = prompt(`Reason for removing "${item.name}" from this order:`);
    if (raw === null) return; // cancelled
    const reason = raw.trim();
    if (!reason) {
      onMessage('error', 'A reason is required to remove an item');
      return;
    }
    await onDeleteItem(item, reason);
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3>
          {title}
          {headerAmount != null && ` · ${formatCurrency(headerAmount)}`}
        </h3>

        {grouped && (
          <p className={styles.muted}>Orders: {orders.map((o) => o.orderNumber).join(', ')}</p>
        )}

        {meta && (
          <div className={styles.modalSubheader}>
            <span>Type: {meta.orderType === 'dine_in' ? 'Dine In' : 'TakeAway'}</span>
            {meta.invoiceNumber && <span>Invoice No.: {meta.invoiceNumber}</span>}
            <span className={`${styles.statusBadge} ${statusClass(meta.status)}`}>
              {statusLabel(meta.status)}
            </span>
          <div>
            <span>Date: {new Date(meta.date).toLocaleString('en-IN', {day:'2-digit', month: '2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false})}</span>
          </div>
          </div>
        )}

        {meta && meta.status !== 'open' && (
          <p className={styles.lockedNotice}>
            This order is {statusLabel(meta.status).toLowerCase()} — items can be viewed but not
            edited.
          </p>
        )}

        {loading ? (
          <p className={styles.muted}>Loading items…</p>
        ) : (
          <table className={styles.itemsTable}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Qty</th>
                <th>Price</th>
                <th>Total</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => {
                const showOrderHeader =
                  grouped && item.orderNumber !== undefined && items[idx - 1]?.orderNumber !== item.orderNumber;
                const isEditing = editing?.id === item.orderItemId;
                return (
                  <Fragment key={item.orderItemId}>
                    {showOrderHeader && (
                      <tr className={styles.groupHeaderRow}>
                        <td colSpan={5}>Order #{item.orderNumber}</td>
                      </tr>
                    )}
                    <tr className={item.isDeleted ? styles.deletedRow : undefined}>
                      {isEditing && editing ? (
                        <>
                          <td>{item.name}</td>
                          <td>
                            <input
                              type="number"
                              className={styles.inlineInput}
                              value={editing.quantity}
                              onChange={(e) => setEditing({ ...editing, quantity: e.target.value })}
                            />
                          </td>
                          <td>{formatCurrency(item.unitPrice)}</td>
                          <td>{formatCurrency(Number(editing.quantity) * item.unitPrice || 0)}</td>
                          <td className={styles.itemActions}>
                            <button className={styles.smallBtn} onClick={submitEdit}>
                              Save
                            </button>
                            <button className={styles.smallBtnGhost} onClick={() => setEditing(null)}>
                              Cancel
                            </button>
                          </td>
                        </>
                      ) : (
                        <>
                          <td>
                            {item.name}
                            {item.isDeleted && <span className={styles.tag}>deleted</span>}
                            {!item.isDeleted && item.editedAt && (
                              <span className={styles.tag}>edited</span>
                            )}
                          </td>
                          <td>{item.quantity}</td>
                          <td>{formatCurrency(item.unitPrice)}</td>
                          <td>{formatCurrency(item.totalPrice)}</td>
                          <td className={styles.itemActions}>
                            {!item.isDeleted && editable && (
                              <>
                                <button className={styles.smallBtn} onClick={() => startEdit(item)}>
                                  Edit
                                </button>
                                <button
                                  className={styles.smallBtnDanger}
                                  onClick={() => submitDelete(item)}
                                >
                                  Remove
                                </button>
                              </>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                    {isEditing && editing && (
                      <tr>
                        <td colSpan={5} className={styles.reasonRow}>
                          <input
                            type="text"
                            className={styles.reasonInput}
                            placeholder="Reason for this edit (required)"
                            value={editing.reason}
                            onChange={(e) => setEditing({ ...editing, reason: e.target.value })}
                            autoFocus
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}

        {!loading && totals && (
          <div className={styles.totalBreakdown}>
            <div className={styles.breakdownRow}>
              <span>Subtotal</span>
              <span>{formatCurrency(totals.subtotalAmount)}</span>
            </div>

            {totals.orderType === 'pickup' || totals.orderType === 'takeaway' ? (
              <>
                <div className={styles.breakdownRow}>
                  <span>Container Charge</span>
                  <span>{formatCurrency(totals.containerChargeAmount)}</span>
                </div>
                <div className={styles.breakdownRow}>
                  <span>GST</span>
                  <span>{formatCurrency(totals.taxAmount)}</span>
                </div>
              </>
            ) : (
              <>
                <div className={styles.breakdownRow}>
                  <span>GST</span>
                  <span>{formatCurrency(totals.taxAmount)}</span>
                </div>
                {totals.discountAmount > 0 && (
                  <div className={styles.breakdownRow}>
                    <span>Discount</span>
                    <span>-{formatCurrency(totals.discountAmount)}</span>
                  </div>
                )}
              </>
            )}

            <div className={`${styles.breakdownRow} ${styles.breakdownTotal}`}>
              <span>Grand Total</span>
              <span>{formatCurrency(totals.totalAmount)}</span>
            </div>
          </div>
        )}

        {!loading && (
          <>
            <h4 className={styles.logHeading}>Activity Log</h4>
            {log.length === 0 ? (
              <p className={styles.muted}>No items have been edited or removed.</p>
            ) : (
              <table className={styles.itemsTable}>
                <thead>
                  <tr>
                    <th>Item</th>
                    {grouped && <th>Order #</th>}
                    <th>Action</th>
                    <th>Qty</th>
                    <th>Reason</th>
                    <th>By</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {log
                    .slice()
                    .reverse()
                    .map((entry) => (
                      <tr key={entry.auditId}>
                        <td>{entry.itemName}</td>
                        {grouped && <td>{entry.orderNumber ?? '—'}</td>}
                        <td>{entry.action === 'delete' ? 'Removed' : 'Modified'}</td>
                        <td>
                          {entry.action === 'delete'
                            ? entry.newQuantity ?? entry.oldQuantity
                            : entry.oldQuantity !== entry.newQuantity
                              ? `${entry.oldQuantity} → ${entry.newQuantity}`
                              : entry.newQuantity}
                          {entry.action === 'edit' && entry.oldUnitPrice !== entry.newUnitPrice && (
                            <div className={styles.timelineDetail}>
                              {formatCurrency(entry.oldUnitPrice ?? 0)} →{' '}
                              {formatCurrency(entry.newUnitPrice ?? 0)}
                            </div>
                          )}
                        </td>
                        <td>{entry.reason || '—'}</td>
                        <td>{entry.changedByName}</td>
                        <td>{new Date(entry.changedAt).toLocaleString('en-IN')}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </>
        )}

        <div className={styles.modalActions}>
          <button className={styles.cancelBtn} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
