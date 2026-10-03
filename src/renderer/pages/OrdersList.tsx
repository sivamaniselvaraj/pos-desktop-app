import { useEffect, useMemo, useRef, useState } from 'react';
import { Toast } from '../components/Toast';
import { Icon } from '../components/Icon';
import { OrderDetailModal } from '../components/OrderDetailModal';
import { ApprovalModal } from '../components/ApprovalModal';
import type {
  OrderListRow,
  OrderListStatus,
  OrderDetailItem,
  OrderActivityLogEntry,
  EditorApproval,
} from '@shared/types';
import pageStyles from '../styles/Page.module.css';
import styles from '../styles/OrdersList.module.css';

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
  // What a pending cancel applies to: one order (any order type, or one round
  // of a dine-in table) or a whole dine-in invoice ("cancel all rounds").
  const [cancelTarget, setCancelTarget] = useState<
    | { scope: 'order'; orderId: string; title: string; summary: string }
    | { scope: 'invoice'; invoiceNumber: string; title: string; summary: string }
    | null
  >(null);
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

  async function handleComplete(row: OrderListRow) {
    if (!confirm('Mark this order# ' +row.orderNumber+' as completed?')) return;
    try {
      setBusyOrderId(row.orderId);
      await window.api.completeOrder(row.orderId);
      flash('success', 'Order completed');
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to complete order');
    } finally {
      setBusyOrderId(null);
    }
  }

  function openCancelOrder(orderId: string, title: string, summary = '') {
    setCancelTarget({ scope: 'order', orderId, title, summary });
    setCancelReason('');
  }

    function openCancelRow(r: OrderListRow) {
    if (r.orderCount > 1 && r.invoiceNumber) {
      setCancelTarget({
        scope: 'invoice',
        invoiceNumber: r.invoiceNumber,
        title: `Cancel all ${r.orderCount} orders`,
        summary: `${r.orderType === DINE_IN_ORDER_TYPE ? `Table ${r.tableNumber ?? '—'}` : 'Invoice'} · ${r.invoiceNumber} · ${formatCurrency(r.totalAmount)}. Every order (round) on this invoice will be cancelled and the table released.`,
      });
    } else {
      openCancelOrder(r.orderId, `Cancel Order ${r.orderNumber}`);
    }
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
    const reason = cancelReason.trim();
    if (cancelTarget.scope === 'invoice') {
      await window.api.cancelInvoiceWithReason(cancelTarget.invoiceNumber, reason, approval);
      flash('success', 'All orders on the invoice cancelled');
    } else {
      await window.api.cancelOrderWithReason(cancelTarget.orderId, reason, approval);
      flash('success', 'Order cancelled');
    }
setCancelApproval(false);
      setCancelTarget(null);
try {
      // If the detail view is open (cancel-this-round), refresh it too.
      if (detailInvoiceNumber) await reloadDetail();
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Cancelled, but failed to refresh');
    }
  }

  // Order detail is always fetched by invoice number — one path for every
  // order type. A dine-in invoice returns every round; a pickup/delivery
  // invoice returns its single order.
  async function fetchDetail(invoiceNumber: string) {
        const [detail, log] = await Promise.all([
          window.api.getInvoiceOrderDetail(invoiceNumber),
          window.api.getInvoiceActivityLog(invoiceNumber),
        ]);
        setDetailOrders(detail.orders);
        setDetailItems(detail.items);
        setDetailLog(log);
  }

  async function openDetail(row: OrderListRow) {
    if (!row.invoiceNumber) {
      flash('error', 'This order has no invoice number, so its details cannot be loaded.');
      return;
    }
    setDetailOrderId(row.orderId);
    setDetailIsDineIn(row.orderType === DINE_IN_ORDER_TYPE);
    setDetailInvoiceNumber(row.invoiceNumber);
    try {
      setDetailLoading(true);
      await fetchDetail(row.invoiceNumber);
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to load order details');
      closeDetail();
    } finally {
      setDetailLoading(false);
    }
  }

  async function reloadDetail() {
    if (!detailInvoiceNumber) return;
    await fetchDetail(detailInvoiceNumber);
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
                        {r.cancelledCount > 0 && r.cancelledCount < r.orderCount && (
                          <span
                            className={styles.partialCancelBadge}
                            title="Some orders on this invoice are cancelled; totals exclude them"
                          >
                            {r.cancelledCount} cancelled
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
                                title={
                                  grouped
                                    ? 'This invoice has multiple orders — complete each round from the item view'
                                    : 'Complete'
                                }
                              onClick={() => handleComplete(r)}
                                disabled={busyOrderId === r.orderId || grouped}
                            >
                              <Icon name="check" size={16} />
                            </button>
                            <button
                              className={styles.iconBtn}
                                title={grouped ? `Cancel all ${r.orderCount} orders` : 'Cancel'}
                                onClick={() => openCancelRow(r)}
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
          onCancelRound={
            detailIsDineIn
              ? (round) =>
                  openCancelOrder(
                    round.id,
                    `Cancel order #${round.orderNumber}`,
                    'Only this order is cancelled; the other orders on the table stay as they are.',
                  )
              : undefined
          }
          onEditItem={handleEditItem}
          onDeleteItem={handleDeleteItem}
          onMessage={flash}
        />
      )}

      {/* Cancel-reason modal */}
      {cancelTarget && (
        <div className={styles.modalOverlay} onClick={() => setCancelTarget(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>{cancelTarget.title}</h3>
            {cancelTarget.summary && <p className={pageStyles.muted}>{cancelTarget.summary}</p>}
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
              >
                {cancelTarget.scope === 'invoice' ? 'Cancel All Orders' : 'Cancel Order'}
              </button>
            </div>
          </div>
          {cancelApproval && (
            <div onClick={(e) => e.stopPropagation()}>
              <ApprovalModal
                action={cancelTarget.title}
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
