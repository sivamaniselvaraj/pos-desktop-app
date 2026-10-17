import { Fragment, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import type { OrderDetailItem, OrderActivityLogEntry, EditorApproval, OrderDiscountMode, OrderDiscountInfo} from '@shared/types';
import { DINE_IN_ORDER_TYPE, PICK_UP_ORDER_TYPE } from '../../shared/types';
import { DiscountModal } from './DiscountModal';
import { ApprovalModal } from './ApprovalModal';
import styles from '../styles/OrderDetailModal.module.css';

import { displayInvoiceNumber, formatMoney as formatCurrency, formatDateTime, taxLabel } from '../lib/format';

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
  discountValue: number;
  totalAmount: number;
  orderType: string;
}

export interface OrderDetailModalProps {
  /** Heading, e.g. "Table T4" or "Order a1b2c3d4". */
  title: string;
  /** Shown after " · " next to the title, e.g. the order/batch grand total. */
  headerAmount?: number;
  /** Every order (round) in this batch. Length > 1 shows the "Orders: #, #, …" line and Order # group headers/columns; length <= 1 hides all of that grouping UI. */
  orders: { id: string; orderNumber: number; status?: string }[];
  meta?: OrderDetailModalMeta;
  totals?: OrderDetailModalTotals;
  items: OrderDetailItem[];
  log: OrderActivityLogEntry[];
  loading: boolean;
  /** Whether the Edit/Remove actions render at all — false for a locked (completed/cancelled) order. */
  editable: boolean;
  onClose: () => void;
  /** Dine-in only: complete just this one round. */
  onCompleteRound?: (round: { id: string; orderNumber: number }) => void;
  /** Dine-in only: cancel just this one round. The caller owns the reason/approval flow. Omit to hide the buttons. */
  onCancelRound?: (round: { id: string; orderNumber: number }) => void;
  /** Persist the edit (call the editOrderItem IPC, reload, refresh the caller's own list) — quantity/reason are already validated non-empty/positive by this component before it's called. */
  onEditItem: (
    orderItemId: string,
    quantity: number,
    reason: string,
    approval: EditorApproval,
  ) => Promise<void>;
  /** Persist the removal (call deleteOrderItem, reload, refresh) — reason is already collected and validated non-empty by this component before it's called. */
  onDeleteItem: (item: OrderDetailItem, reason: string, approval: EditorApproval) => Promise<void>;
  /** Give a discount / mark complimentary on these orders. Resolve when saved (the caller reloads); throw to show the message. Omit to hide the button. */
  /** Discount / complimentary details per order (only orders that have one). Shown under the totals. */
  discounts?: OrderDiscountInfo[];
  /** When there is no `totals` (Dashboard), the figures the Discount dialog shows. */
  discountSummary?: { discountAmount: number; totalAmount: number,  discountPercent: number};
  /** Dine-in: jump to New Order with this table preselected, to add another round of items. Omit to hide the button. */
  onAddItems?: () => void;
  onDiscount?: (orderIds: string[], mode: OrderDiscountMode, value: number | undefined, reason: string) => Promise<void>;
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
  items: rawItems,
  log,
  loading,
  editable,
  onClose,
  onCompleteRound,
  onCancelRound,
  onDiscount,
  onAddItems,
  discounts,
  discountSummary,
  onEditItem,
  onDeleteItem,
  onMessage,
}: OrderDetailModalProps) {
  // Buttons appear only when one of the user's groups grants the matching permission.
  const { can } = useAuth();
  const canEditItems = editable && can('orders.edit');
  const canCancelRound = editable && can('orders.cancel');
  const canCompleteRound = editable && can('orders.complete');
  const discountFigures = totals
    ? { discountAmount: totals.discountAmount, totalAmount: totals.totalAmount, discountPercent: totals.discountValue }
    : discountSummary;
  const canDiscount = editable && !!onDiscount && !!discountFigures && can('orders.discount');
  const [discountOpen, setDiscountOpen] = useState(false);
  const [editing, setEditing] = useState<{
    id: string;
    mode: 'edit' | 'remove';
    quantity: string;
    reason: string;
  } | null>(null);
  // Pending change awaiting editor approval. The callbacks must THROW on
  // failure (e.g. wrong editor password) so ApprovalModal can show the error
  // and let the editor retry; resolve on success.
  const [pending, setPending] = useState<{
    action: string;
    run: (approval: EditorApproval) => Promise<void>;
  } | null>(null);
  const grouped = orders.length > 1;
  // One block per order: items sorted by order number (stable, so each order keeps its own item order).
  const items = useMemo(
    () =>
      rawItems
        .map((it, idx) => ({ it, idx }))
        .sort((a, b) => (a.it.orderNumber ?? 0) - (b.it.orderNumber ?? 0) || a.idx - b.idx)
        .map((x) => x.it),
    [rawItems],
  );
  /** Edit/Remove are not offered for items of a cancelled order. */
  const isRoundCancelled = (orderNumber: number | undefined) =>
    orderNumber !== undefined && orders.find((o) => o.orderNumber === orderNumber)?.status === 'cancelled';

  function startEdit(item: OrderDetailItem) {
    setEditing({ id: item.orderItemId, mode: 'edit', quantity: String(item.quantity), reason: '' });
  }

  /** Opens the reason box for removing an item (window.prompt is not available in Electron). */
  function startRemove(item: OrderDetailItem) {
    // Removing the last live item would leave an empty (void) order.
    if (isRoundCancelled(item.orderNumber)) return;
    const liveInOrder = items.filter(
      (i) => !i.isDeleted && (item.orderNumber === undefined || i.orderNumber === item.orderNumber),
    );
    if (liveInOrder.length <= 1) {
      onMessage(
        'error',
        `"${item.name}" is the only item in ${
          item.orderNumber !== undefined ? `order #${item.orderNumber}` : 'this order'
        }. Removing it would leave an empty order. Cancel the order instead.`,
      );
      return;
    }
    setEditing({ id: item.orderItemId, mode: 'remove', quantity: String(item.quantity), reason: '' });
  }

  function submitEdit() {
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
    const itemId = editing.id;
    const itemName = items.find((i) => i.orderItemId === itemId)?.name ?? 'item';
    setPending({
      action: `Edit "${itemName}" to quantity ${quantity}`,
      run: async (approval) => {
        await onEditItem(itemId, quantity, reason, approval);
        setEditing(null);
      },
    });
  }

  function submitDelete() {
    if (!editing) return;
    const item = items.find((i) => i.orderItemId === editing.id);
    if (!item) return;
    const reason = editing.reason.trim();
    if (!reason) {
      onMessage('error', 'A reason is required to remove an item');
      return;
    }
    setPending({
      action: `Remove "${item.name}"`,
      run: async (approval) => {
        await onDeleteItem(item, reason, approval);
        setEditing(null);
      },
    });
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
            <span>Type: {meta.orderType === DINE_IN_ORDER_TYPE ? 'Dine In' : 'Takeaway'}</span>
            {meta.invoiceNumber && <span>Invoice No.: {displayInvoiceNumber(meta.invoiceNumber)}</span>}
            <span className={`${styles.statusBadge} ${statusClass(meta.status)}`}>
              {statusLabel(meta.status)}
            </span>
          <div>
            <span>Date: {new Date(meta.date).toLocaleString('en-IN', {day:'2-digit', month: '2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit', hour12:true})}</span>
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
                        <td colSpan={5}>
                          <span>Order #{item.orderNumber}</span>
                          {(() => {
                            const round = orders.find((o) => o.orderNumber === item.orderNumber);
                            if (!round) return null;
                            if (round.status === 'completed') {
                              return <span className={styles.tag}>completed</span>;
                            }
                            if (round.status === 'cancelled') {
                              return <span className={styles.tag}>cancelled</span>;
                            }
                            
                            return (
                              <>
                              { onCompleteRound && canCompleteRound &&(
                                <button
                                  className={styles.smallBtn}
                                  style={{ float: 'right', marginLeft: '8px' }}
                                  onClick={() => onCompleteRound({ id: round.id, orderNumber: round.orderNumber })}
                                >
                                  Complete this order
                                </button>
                              )}

                             { onCancelRound && canCancelRound && (
                                <button
                                  className={styles.smallBtnDanger}
                                  style={{ float: 'right' }}
                                  onClick={() => onCancelRound({ id: round.id, orderNumber: round.orderNumber })}
                                >
                                  Cancel this order
                                </button>
                             )}
                            </>
                          )
                          })()}
                        </td>
                      </tr>
                    )}
                    <tr className={item.isDeleted ? styles.deletedRow : undefined}>
                      {isEditing && editing && editing.mode === 'remove' ? (
                        <>
                          <td>{item.name}</td>
                          <td>{item.quantity}</td>
                          <td>{formatCurrency(item.unitPrice)}</td>
                          <td>{formatCurrency(item.totalPrice)}</td>
                          <td className={styles.itemActions}>
                            <button className={styles.smallBtnDanger} onClick={submitDelete}>
                              Remove
                            </button>
                            <button className={styles.smallBtnGhost} onClick={() => setEditing(null)}>
                              Cancel
                            </button>
                          </td>
                        </>
                      ) : isEditing && editing ? (
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
                            {!item.isDeleted && canEditItems && !isRoundCancelled(item.orderNumber) && (
                              <>
                                <button className={styles.smallBtn} onClick={() => startEdit(item)}>
                                  Edit
                                </button>
                                <button
                                  className={styles.smallBtnDanger}
                                  onClick={() => startRemove(item)}
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
                            placeholder={
                              editing.mode === 'remove'
                                ? 'Reason for removing this item (required)'
                                : 'Reason for this edit (required)'
                            }
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
            {totals.discountAmount > 0 && (
              <div className={styles.breakdownRow}>
                <span>Discount {totals.discountValue}%</span>
                <span>-{formatCurrency(totals.discountAmount)}</span>
              </div>
            )}

            {totals.orderType === 'pickup' || totals.orderType === PICK_UP_ORDER_TYPE && (  
                <div className={styles.breakdownRow}>
                  <span>Container Charge</span>
                  <span>{formatCurrency(totals.containerChargeAmount)}</span>
                </div>
            )}

            <div className={styles.breakdownRow}>
              <span>{taxLabel()}</span>
              <span>{formatCurrency(totals.taxAmount)}</span>
            </div>

            <div className={`${styles.breakdownRow} ${styles.breakdownTotal}`}>
              <span>Grand Total</span>
              <span>{formatCurrency(totals.totalAmount)}</span>
            </div>

          </div>
        )}

        {!loading && discounts && discounts.length > 0 && (
          <div className={styles.discountBox}>
            <h4 className={styles.logHeading}>Discount</h4>
            {discounts.map((d) => (
              <div key={d.orderId} className={styles.discountRow}>
                <div className={styles.discountHead}>
                  <span>
                    {grouped && <>Order #{d.orderNumber} · </>}
                    {d.mode === 'complimentary' ? (
                      <b className={styles.compBadge}>Complimentary</b>
                    ) : d.mode === 'percent' ? (
                      <b>{d.value}% discount</b>
                    ) : (
                      <b>Fixed discount</b>
                    )}
                  </span>
                  <b>-{formatCurrency(d.amount)}</b>
                </div>
                <div className={styles.discountMeta}>
                  {d.mode === 'complimentary' ? 'Value given away' : 'Taken off before tax'}
                  {d.reason ? <> · Reason: {d.reason}</> : null}
                  {d.byName ? <> · By {d.byName}</> : null}
                  {d.at ? <> · {formatDateTime(d.at)}</> : null}
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && canDiscount && discountFigures && (
          <div className={styles.modalActions}>
            <button type="button" className={styles.smallBtn} onClick={() => setDiscountOpen(true)}>
              {discountFigures.discountAmount > 0 || (discounts && discounts.length > 0) ? 'Change discount' : 'Discount / Complimentary'}
            </button>
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
                        <td>{entry.action}</td>
                        <td>
                          {entry.action === 'order.item.delete'
                            ? entry.newQuantity ?? entry.oldQuantity
                            : entry.oldQuantity !== entry.newQuantity
                              ? `${entry.oldQuantity} → ${entry.newQuantity}`
                              : entry.newQuantity}
                          {entry.action === 'order.item.edit' && entry.oldUnitPrice !== entry.newUnitPrice && (
                            <div className={styles.timelineDetail}>
                              {formatCurrency(entry.oldUnitPrice ?? 0)} →{' '}
                              {formatCurrency(entry.newUnitPrice ?? 0)}
                            </div>
                          )}
                        </td>
                        <td>{entry.reason || '—'}</td>
                        <td>{entry.changedByName}</td>
                        <td>{formatDateTime(entry.changedAt)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </>
        )}

        <div className={styles.modalActions}>
          {editable && onAddItems && (
            <button className={styles.addItemsBtn} onClick={onAddItems}>
              + Add items
            </button>
          )}
          <button className={styles.cancelBtn} onClick={onClose}>
            Close
          </button>
        </div>

        {discountOpen && discountFigures && onDiscount && (
          <DiscountModal
            title={title}
            orderIds={orders.filter((o) => o.status !== 'cancelled').map((o) => o.id)}
            currentDiscount={discountFigures.discountAmount}
            currentTotal={discountFigures.totalAmount}
            currentDiscountPercent={discountFigures.discountPercent}
            onClose={() => setDiscountOpen(false)}
            onApply={async (mode, value, reason) => {
              await onDiscount(
                orders.filter((o) => o.status !== 'cancelled').map((o) => o.id),
                mode,
                value,
                reason,
              );
              setDiscountOpen(false);
            }}
          />
        )}

        {pending && (
          <ApprovalModal
            action={pending.action}
            onCancel={() => setPending(null)}
            onSubmit={async (approval) => {
              await pending.run(approval);
              setPending(null);
            }}
          />
        )}
      </div>
    </div>
  );
}
