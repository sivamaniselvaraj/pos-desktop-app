import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { OrderDetailModal } from '../components/OrderDetailModal';
import type {
  OrderListRow,
  OrderListStatus,
  OrderDetailItem,
  OrderActivityLogEntry,
  EditorApproval,
} from '@shared/types';
import pageStyles from '../styles/Page.module.css';
import styles from '../styles/OrdersList.module.css';
import { Toast } from '../components/Toast';
import { ApprovalModal } from '../components/ApprovalModal';

const PAGE_SIZE = 25;
// list_orders() no longer counts the outlet's whole history (that count was
// the linear cost that made it time out on large datasets) — it counts only
// up to this many rows past the current page. Keep in sync with the "+ 100"
// in db/functions.sql.
const COUNT_LOOKAHEAD = 100;

const DINE_IN_ORDER_TYPE = 'dine_in';

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
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
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
  const [detailIsDineIn, setDetailIsDineIn] = useState(false);
  // Set only for a dine-in row whose invoice_number is known — the grid's
  // rows are already grouped by invoice (see list_orders() in
  // db/functions.sql), so opening one fetches the WHOLE invoice group via
  // get_orders_by_invoice() rather than re-deriving the table's live batch
  // from a single anchor order id. Falls back to the older table-batch fetch
  // (getTableOrderDetail/getTableActivityLog) only for a legacy dine-in
  // order that predates the invoice_number column.
  const [detailInvoiceNumber, setDetailInvoiceNumber] = useState<string | null>(null);
  const [detailOrders, setDetailOrders] = useState<{ id: string; orderNumber: number }[]>([]);
  
  const [detailItems, setDetailItems] = useState<OrderDetailItem[]>([]);
  const [detailLog, setDetailLog] = useState<OrderActivityLogEntry[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  // Cancel-reason modal
  const [cancelTarget, setCancelTarget] = useState<{ orderId: string; orderNumber: string }  | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelApproval, setCancelApproval] = useState(false);

  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  // True when the lookahead was exhausted — more rows exist than totalRows says.
  const totalIsApproximate = totalRows >= page * PAGE_SIZE + COUNT_LOOKAHEAD;

  // Tracks the previously-applied search term so the status auto-switch
  // below only fires on a genuine transition (search starting or clearing),
  // never on initial mount — a plain useEffect on [searchInput] would
  // otherwise also fire once on mount with an empty value and incorrectly
  // stomp on whatever status tab the page opened with.
  const prevSearchRef = useRef('');

  function applySearch(trimmed: string) {
    const wasSearching = prevSearchRef.current !== '';
    const isSearching = trimmed !== '';

    setDebouncedSearch(trimmed);
    if (isSearching && !wasSearching) {
      setStatusFilter('all'); // searching should look across every status, not just Active
    } else if (!isSearching && wasSearching) {
      setStatusFilter('active'); // back to the default view once search is cleared
    }

    prevSearchRef.current = trimmed;
    setPage(1);
  }

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const result = await window.api.listOrders({
        status: statusFilter === 'all' ? null : statusFilter,
        search: debouncedSearch || undefined,
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
    // Debounce free-typed search input before it triggers a fetch — avoids
  // firing a request on every keystroke. Resets to page 1 once the debounced
  // value actually changes.
  useEffect(() => {
    const timer = setTimeout(() => applySearch(searchInput.trim()), 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, debouncedSearch, fromDate, toDate, page]);

  function selectStatus(s: StatusFilter) {
    setStatusFilter(s);
    setPage(1);
  }

  function flash(type: 'success' | 'error', text: string) {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 4000);
  }

  async function handlePrint(row: OrderListRow) {
    try {
      setBusyOrderId(row.orderId);
      if (row.orderType === DINE_IN_ORDER_TYPE) {
        await window.api.reprintTableBill(row.orderId);
      } else {
        await window.api.reprintOrder(row.orderId);
      }
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

  function openCancel(orderId: string, orderNumber: string) {
    setCancelTarget({orderId, orderNumber});
    setCancelReason('');
  }

  // Step 1 of cancel: validate the reason, then ask for editor approval.
  function submitCancel() {
    if (!cancelTarget) return;
    if (!cancelReason.trim()) {
      flash('error', 'A reason is required to cancel an order');
      return;
    }
    setCancelApproval(true);
  }

  // Step 2: runs inside ApprovalModal; throws on a rejected approval so the
  // editor can retry without losing the reason.
  async function confirmCancel(approval: EditorApproval): Promise<void> {
    if (!cancelTarget) return;
      await window.api.cancelOrderWithReason(cancelTarget.orderId, cancelReason.trim(), approval);
      flash('success', 'Order cancelled');
setCancelApproval(false);
      setCancelTarget(null);
try {
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Cancelled, but failed to refresh');
    }
  }

  async function openDetail(row: OrderListRow) {
    const isDineIn = row.orderType === DINE_IN_ORDER_TYPE;
    const invoiceNumber = isDineIn ? row.invoiceNumber ?? null : null;
    setDetailOrderId(row.orderId);
    setDetailIsDineIn(isDineIn);
    setDetailInvoiceNumber(invoiceNumber);
    try {
      setDetailLoading(true);
      if (invoiceNumber) {
        // Grouped dine-in row: fetch every order sharing this invoice_number.
        const [detail, log] = await Promise.all([
          window.api.getInvoiceOrderDetail(invoiceNumber),
          window.api.getInvoiceActivityLog(invoiceNumber),
        ]);
        setDetailOrders(detail.orders);
        setDetailItems(detail.items);
        setDetailLog(log);
      } else {
      const [items, log] = await Promise.all([
        window.api.getOrderDetail(row.orderId),
        window.api.getOrderActivityLog(row.orderId),
      ]);
      setDetailOrders([]);
      setDetailItems(items);
      setDetailLog(log);
      }
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to load order details');
      setDetailOrderId(null);
    } finally {
      setDetailLoading(false);
    }
  }

  async function reloadDetail() {
    if (!detailOrderId) return;
    if (detailInvoiceNumber) {
      const [detail, log] = await Promise.all([
        window.api.getInvoiceOrderDetail(detailInvoiceNumber),
        window.api.getInvoiceActivityLog(detailInvoiceNumber),
      ]);
      setDetailOrders(detail.orders);
      setDetailItems(detail.items);
      setDetailLog(log);
    } else {
      const [items, log] = await Promise.all([
        window.api.getOrderDetail(detailOrderId),
        window.api.getOrderActivityLog(detailOrderId),
      ]);
      setDetailItems(items);
      setDetailLog(log);
    }
  }

  function closeDetail() {
    setDetailOrderId(null);
    setDetailIsDineIn(false);
    setDetailInvoiceNumber(null);
    setDetailOrders([]);
    setDetailItems([]);
    setDetailLog([]);
  }

    async function refreshAfterWrite(): Promise<void> {
    try {
      await reloadDetail();
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Saved, but failed to refresh');
    }
  }

  async function handleEditItem(
    orderItemId: string,
    quantity: number,
    reason: string,
    approval: EditorApproval,
  ): Promise<void> {
    await window.api.editOrderItem({ orderItemId, quantity, reason, approval });
      flash('success', 'Item updated');
    await refreshAfterWrite();
  }

  async function handleDeleteItem(
    item: OrderDetailItem,
    reason: string,
    approval: EditorApproval,
  ): Promise<void> {
    await window.api.deleteOrderItem(item.orderItemId, reason, approval);
    flash('success', 'Item removed');
    await refreshAfterWrite();
  }

  const detailOrder = useMemo(
    () => rows.find((r) => r.orderId === detailOrderId),
    [rows, detailOrderId],
  );

  return (
    <div className={pageStyles.page}>
      <h2>Orders</h2>
            <div className={styles.searchRow}>
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Search by Order ID..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        {searchInput && (
          <button
            className={styles.clearDatesBtn}
            onClick={() => {
              setSearchInput('');
              applySearch(''); // instant, no reason to wait for the debounce timer
            }}
          >
            Clear
          </button>
        )}
      </div>

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

      <Toast message={message} />
      {error && <p className={styles.error}>{error}</p>}
      {loading && <p className={pageStyles.muted}>Loading orders…</p>}

      {!loading && !error && (
        <>
          <table className={pageStyles.table}>
            <thead>
              <tr>
                <th>Order / Table</th>
                <th>Invoice No.</th>
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
                  <td colSpan={8} className={pageStyles.muted}>
                    No orders match this filter.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const grouped = r.orderCount > 1;
                  return (
                    <tr key={r.invoiceNumber ?? r.orderId}>
                      <td className={styles.orderIdCell}>
                      <button className={styles.linkBtn} onClick={() => openDetail(r)}>
                        {r.orderType === DINE_IN_ORDER_TYPE
                          ? `Table ${r.tableNumber ?? '—'}`
                          : r.orderNumber}
                      </button>
                        {grouped && (
                          <span className={styles.editedBadge} title="This invoice groups multiple orders/rounds">
                            {r.orderCount} orders
                          </span>
                        )}
                      {r.hasEdits && (
                        <span className={styles.editedBadge} title="This order has edited or removed items">
                          <Icon name="edit" size={11} />
                          edited
                        </span>
                      )}
                    </td>
                    <td>{r.invoiceNumber ?? '—'}</td>
                    <td>{r.orderType === DINE_IN_ORDER_TYPE ? 'Dine In' : 'Takeaway'}</td>
                    <td>{new Date(r.createdAt).toLocaleString('en-IN', {day:'2-digit', month: '2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit', hour12:true})}</td>
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
                          onClick={() => handlePrint(r)}
                          disabled={busyOrderId === r.orderId}
                        >
                          <Icon name="print" size={16} />
                        </button>
                        <button
                          className={styles.iconBtn}
                          title="View / Edit Items"
                          onClick={() => openDetail(r)}
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
                                title={
                                  grouped
                                    ? 'This invoice has multiple orders — cancel each round from the item view'
                                    : 'Cancel'
                                }
                              onClick={() => openCancel(r.orderId, r.orderNumber)}
                              disabled={busyOrderId === r.orderId}
                            >
                              <Icon name="cancel" size={16} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })
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
              Page {page} of {totalPages}{totalIsApproximate ? '+' : ''} ({totalRows}
              {totalIsApproximate ? '+' : ''} order{totalRows === 1 ? '' : 's'})
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
        <OrderDetailModal
          title={
            detailIsDineIn
              ? `Table ${detailOrder?.tableNumber ?? '—'}`
              : `Order# ${detailOrder?.orderNumber}`
          }
          headerAmount={detailOrder?.totalAmount}
          orders={detailOrders}
          meta={
            detailOrder
              ? {
                  orderType: detailOrder.orderType,
                  status: detailOrder.status,
                  invoiceNumber: detailOrder.invoiceNumber,
                  date: detailOrder.createdAt
                }
              : undefined
          }
          totals={
            detailOrder
              ? {
                  subtotalAmount: detailOrder.subtotalAmount,
                  taxAmount: detailOrder.taxAmount,
                  containerChargeAmount: detailOrder.containerChargeAmount,
                  discountAmount: detailOrder.discountAmount,
                  totalAmount: detailOrder.totalAmount,
                  orderType: detailOrder.orderType,
                }
              : undefined
          }
          items={detailItems}
          log={detailLog}
          loading={detailLoading}
          editable={detailOrder?.status === 'open'}
          onClose={closeDetail}
          onEditItem={handleEditItem}
          onDeleteItem={handleDeleteItem}
          onMessage={flash}
        />
      )}

      {/* Cancel-reason modal */}
      {cancelTarget && (
        <div className={styles.modalOverlay} onClick={() => setCancelTarget(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>Cancel Order {cancelTarget.orderNumber}</h3>
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
                disabled={busyOrderId === cancelTarget.orderId}
              >
                {busyOrderId === cancelTarget.orderId ? 'Cancelling…' : 'Cancel Order'}
              </button>
            </div>
          </div>
          {cancelApproval && (
            <div onClick={(e) => e.stopPropagation()}>
              <ApprovalModal
                action={`Cancel order ${cancelTarget.orderNumber}`}
                onCancel={() => setCancelApproval(false)}
                onSubmit={confirmCancel}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
