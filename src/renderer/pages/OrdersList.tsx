import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import type {
  OrderListRow,
  OrderListStatus,
  OrderDetailItem,
  OrderActivityLogEntry,
} from '@shared/types';
import pageStyles from '../styles/Page.module.css';
import styles from '../styles/OrdersList.module.css';

const PAGE_SIZE = 25;

type StatusFilter = OrderListStatus | 'all';

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

export function OrdersList() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [page, setPage] = useState(1);

  const [rows, setRows] = useState<OrderListRow[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null,
  );
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);

  // Item view/edit modal — also carries the activity log, shown below the items table
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null);
  const [detailOrderNumber, setDetailOrderNumber] = useState<string | null>(null);
  
  const [detailItems, setDetailItems] = useState<OrderDetailItem[]>([]);
  const [detailLog, setDetailLog] = useState<OrderActivityLogEntry[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editing, setEditing] = useState<{ id: string; quantity: string } | null>(null);

  // Cancel-reason modal
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const result = await window.api.listOrders({
        status: statusFilter === 'all' ? null : statusFilter,
        from: fromDate || undefined,
        to: toDate || undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      setRows(result.rows);
      setTotalRows(result.totalRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, fromDate, toDate, page]);

  function selectStatus(s: StatusFilter) {
    setStatusFilter(s);
    setPage(1);
  }

  function flash(type: 'success' | 'error', text: string) {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 4000);
  }

  async function handlePrint(orderId: string) {
    try {
      setBusyOrderId(orderId);
      await window.api.reprintOrder(orderId);
      flash('success', 'Sent to printer');
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Print failed');
    } finally {
      setBusyOrderId(null);
    }
  }

  async function handleComplete(orderId: string) {
    if (!confirm('Mark this order as completed?')) return;
    try {
      setBusyOrderId(orderId);
      await window.api.completeOrder(orderId);
      flash('success', 'Order completed');
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to complete order');
    } finally {
      setBusyOrderId(null);
    }
  }

  function openCancel(orderId: string) {
    setCancelTarget(orderId);
    setCancelReason('');
  }

  async function submitCancel() {
    if (!cancelTarget) return;
    if (!cancelReason.trim()) {
      flash('error', 'A reason is required to cancel an order');
      return;
    }
    try {
      setBusyOrderId(cancelTarget);
      await window.api.cancelOrderWithReason(cancelTarget, cancelReason.trim());
      flash('success', 'Order cancelled');
      setCancelTarget(null);
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to cancel order');
    } finally {
      setBusyOrderId(null);
    }
  }

  async function openDetail(orderId: string, orderNumber: string) {
    setDetailOrderId(orderId);
    setDetailOrderNumber(orderNumber);
    setEditing(null);
    try {
      setDetailLoading(true);
      const [items, log] = await Promise.all([
        window.api.getOrderDetail(orderId),
        window.api.getOrderActivityLog(orderId),
      ]);
      setDetailItems(items);
      setDetailLog(log);
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to load order details');
      setDetailOrderId(null);
      setDetailOrderNumber(null);
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail() {
    setDetailOrderId(null);
    setDetailOrderNumber(null);
    setDetailItems([]);
    setDetailLog([]);
    setEditing(null);
  }

  function startEdit(item: OrderDetailItem) {
    setEditing({
      id: item.orderItemId,
      quantity: String(item.quantity),
    });
  }

  async function saveEdit() {
    if (!editing || !detailOrderId) return;
    const quantity = Number(editing.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      flash('error', 'Quantity must be a positive number');
      return;
    }
    try {
      await window.api.editOrderItem({ orderItemId: editing.id, quantity });
      setEditing(null);
      const [items, log] = await Promise.all([
        window.api.getOrderDetail(detailOrderId),
        window.api.getOrderActivityLog(detailOrderId),
      ]);
      setDetailItems(items);
      setDetailLog(log);
      await load(); // refresh the grid's total/has-edits indicator
      flash('success', 'Item updated');
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to update item');
    }
  }

  async function deleteItem(item: OrderDetailItem) {
    if (!detailOrderId) return;
    if (!confirm(`Remove "${item.name}" from this order?`)) return;
    try {
      await window.api.deleteOrderItem(item.orderItemId);
      const [items, log] = await Promise.all([
        window.api.getOrderDetail(detailOrderId),
        window.api.getOrderActivityLog(detailOrderId),
      ]);
      setDetailItems(items);
      setDetailLog(log);
      await load();
      flash('success', 'Item removed');
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to remove item');
    }
  }

  const detailOrder = useMemo(
    () => rows.find((r) => r.orderId === detailOrderId),
    [rows, detailOrderId],
  );

  return (
    <div className={pageStyles.page}>
      <h2>Orders</h2>

      <div className={styles.filters}>
        <div className={styles.statusTabs}>
          {(['active', 'completed', 'cancelled', 'all'] as StatusFilter[]).map((s) => (
            <button
              key={s}
              className={`${styles.statusTab} ${statusFilter === s ? styles.statusTabActive : ''}`}
              onClick={() => selectStatus(s)}
            >
              {s === 'all' ? 'All' : statusLabel(s === 'active' ? 'open' : s)}
            </button>
          ))}
        </div>

        <div className={styles.dateRange}>
          <label>
            From
            <input
              type="date"
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={toDate}
              onChange={(e) => {
                setToDate(e.target.value);
                setPage(1);
              }}
            />
          </label>
          {(fromDate || toDate) && (
            <button
              className={styles.clearDatesBtn}
              onClick={() => {
                setFromDate('');
                setToDate('');
                setPage(1);
              }}
            >
              Clear
            </button>
          )}
          <button
            className={styles.refreshBtn}
            onClick={load}
            disabled={loading}
            title="Reload orders"
          >
            <Icon name="refresh" size={14} />
            Refresh
          </button>
        </div>
      </div>

      {message && (
        <p className={message.type === 'error' ? styles.error : styles.success}>{message.text}</p>
      )}
      {error && <p className={styles.error}>{error}</p>}
      {loading && <p className={pageStyles.muted}>Loading orders…</p>}

      {!loading && !error && (
        <>
          <table className={pageStyles.table}>
            <thead>
              <tr>
                <th>Order Number</th>
                <th>Type</th>
                <th>Created On</th>
                <th>Items</th>
                <th>Total</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className={pageStyles.muted}>
                    No orders match this filter.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.orderId}>
                    <td>
                      <div className={styles.orderIdCell}>
                      <button className={styles.linkBtn} onClick={() => openDetail(r.orderId, r.orderNumber)}>
                        {r.orderNumber.slice(0, 8)}
                      </button>
                      {r.hasEdits && (
                        <span className={styles.editedBadge} title="This order has edited or removed items">
                          <Icon name="edit" size={11} />
                          edited
                        </span>
                      )}
                      </div>
                    </td>
                    <td>{r.orderType}</td>
                    <td>{new Date(r.createdAt).toLocaleString('en-IN')}</td>
                    <td>{r.itemCount}</td>
                    <td>{formatCurrency(r.totalAmount)}</td>
                    <td>
                      <span className={`${styles.statusBadge} ${statusClass(r.status)}`}>
                        {statusLabel(r.status)}
                      </span>
                    </td>
                    <td>
                      <div className={styles.actions}>
                        <button
                          className={styles.iconBtn}
                          title="Print / Reprint"
                          onClick={() => handlePrint(r.orderId)}
                          disabled={busyOrderId === r.orderId}
                        >
                          <Icon name="print" size={16} />
                        </button>
                        <button
                          className={styles.iconBtn}
                          title="View / Edit Items"
                          onClick={() => openDetail(r.orderId, r.orderNumber)}
                          disabled={busyOrderId === r.orderId}
                        >
                          <Icon name="edit" size={16} />
                        </button>
                        {r.status === 'open' && (
                          <>
                            <button
                              className={styles.iconBtn}
                              title="Complete"
                              onClick={() => handleComplete(r.orderId)}
                              disabled={busyOrderId === r.orderId}
                            >
                              <Icon name="check" size={16} />
                            </button>
                            <button
                              className={styles.iconBtn}
                              title="Cancel"
                              onClick={() => openCancel(r.orderId)}
                              disabled={busyOrderId === r.orderId}
                            >
                              <Icon name="cancel" size={16} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          <div className={styles.pagination}>
            <button
              className={styles.pageBtn}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              Previous
            </button>
            <span className={styles.pageInfo}>
              Page {page} of {totalPages} ({totalRows} order{totalRows === 1 ? '' : 's'})
            </span>
            <button
              className={styles.pageBtn}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              Next
            </button>
          </div>
        </>
      )}

      {/* View / Edit items modal */}
      {detailOrderId && (
        <div className={styles.modalOverlay} onClick={closeDetail}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>
              Order {detailOrderNumber?.slice(0, 8)}
              {detailOrder && ` · ${formatCurrency(detailOrder.totalAmount)}`}
            </h3>

            {detailOrder && (
              <div className={styles.modalSubheader}>
                <span>Type: {detailOrder.orderType}</span>
                <span className={`${styles.statusBadge} ${statusClass(detailOrder.status)}`}>
                  {statusLabel(detailOrder.status)}
                </span>
              </div>
            )}

            {detailOrder && detailOrder.status !== 'open' && (
              <p className={styles.lockedNotice}>
                This order is {statusLabel(detailOrder.status).toLowerCase()} — items can be
                viewed but not edited.
              </p>
            )}

            {detailLoading ? (
              <p className={pageStyles.muted}>Loading items…</p>
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
                  {detailItems.map((item) => (
                    <tr
                      key={item.orderItemId}
                      className={item.isDeleted ? styles.deletedRow : undefined}
                    >
                      {editing?.id === item.orderItemId ? (
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
                            <button className={styles.smallBtn} onClick={saveEdit}>
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
                            {!item.isDeleted && detailOrder?.status === 'open' && (
                              <>
                                <button className={styles.smallBtn} onClick={() => startEdit(item)}>
                                  Edit
                                </button>
                                <button
                                  className={styles.smallBtnDanger}
                                  onClick={() => deleteItem(item)}
                                >
                                  Remove
                                </button>
                              </>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {!detailLoading && detailOrder && (
              <div className={styles.totalBreakdown}>
                <div className={styles.breakdownRow}>
                  <span>Subtotal</span>
                  <span>{formatCurrency(detailOrder.subtotalAmount)}</span>
                </div>

                {detailOrder.orderType === 'pickup' || 'takeaway'? (
                  <>
                    <div className={styles.breakdownRow}>
                      <span>Container Charge</span>
                      <span>{formatCurrency(detailOrder.containerChargeAmount)}</span>
                    </div>
                  </>
                ) : (
                 <></>
                )}
                 <>
                    <div className={styles.breakdownRow}>
                      <span>GST</span>
                      <span>{formatCurrency(detailOrder.taxAmount)}</span>
                    </div>
                    {detailOrder.discountAmount > 0 && (
                      <div className={styles.breakdownRow}>
                        <span>Discount</span>
                        <span>-{formatCurrency(detailOrder.discountAmount)}</span>
                      </div>
                    )}
                  </>

                <div className={`${styles.breakdownRow} ${styles.breakdownTotal}`}>
                  <span>Grand Total</span>
                  <span>{formatCurrency(detailOrder.totalAmount)}</span>
                </div>
              </div>
            )}

            {!detailLoading && (
              <>
                <h4 className={styles.logHeading}>Activity Log</h4>
                {detailLog.length === 0 ? (
                  <p className={pageStyles.muted}>No items have been edited or removed.</p>
                ) : (
                  <table className={styles.itemsTable}>
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th>Action</th>
                        <th>Qty</th>
                        <th>Reason</th>
                        <th>By</th>
                        <th>When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailLog
                        .slice()
                        .reverse()
                        .map((entry) => (
                          <tr key={entry.auditId}>
                            <td>{entry.itemName}</td>
                            <td>{entry.action === 'delete' ? 'Removed' : !entry.action.indexOf('Cancelled') ? 'Modified' : 'Order Cancelled'}</td>
                            <td>
                              {entry.action === 'delete'
                                ? entry.newQuantity ?? entry.oldQuantity
                                : entry.oldQuantity !== entry.newQuantity
                                  ? `${entry.oldQuantity} → ${entry.newQuantity}`
                                  : entry.newQuantity}
                              {/* Historical edits made before price-editing was removed may still
                                  carry a price change — keep showing it for those older rows. */}
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
              <button className={styles.cancelBtn} onClick={closeDetail}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel-reason modal */}
      {cancelTarget && (
        <div className={styles.modalOverlay} onClick={() => setCancelTarget(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>Cancel Order {cancelTarget.slice(0, 8)}</h3>
            <label className={styles.formLabel}>
              Reason (required)
              <textarea
                rows={3}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Why is this order being cancelled?"
              />
            </label>
            <div className={styles.modalActions}>
              <button className={styles.cancelBtn} onClick={() => setCancelTarget(null)}>
                Back
              </button>
              <button
                className={styles.dangerBtn}
                onClick={submitCancel}
                disabled={busyOrderId === cancelTarget}
              >
                {busyOrderId === cancelTarget ? 'Cancelling…' : 'Cancel Order'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
