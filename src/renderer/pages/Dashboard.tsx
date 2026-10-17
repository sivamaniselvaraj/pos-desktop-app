import { useEffect, useMemo, useState } from 'react';
import { Toast } from '../components/Toast';
import { Icon } from '../components/Icon';
import { OrderDetailModal } from '../components/OrderDetailModal';
import { useAuth } from '../context/AuthContext';
import { TableFormModal } from '../components/TableFormModal';
import type {
  TableCard,
  OrderDetailItem,
  OrderActivityLogEntry,
  PaymentMethod,
  EditorApproval,
  OrderDiscountMode,
  OrderDiscountInfo,
  SaveManagedTablePayload,
} from '@shared/types';
import styles from '../styles/TableDashboard.module.css';
import { formatMoney as formatCurrency } from '../lib/format';

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'card', label: 'Card' },
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'part-payment', label: 'Part Payment' },
];


function startedAt(createdAt: string | undefined): string {
  if (!createdAt) return '';
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function elapsedMinutes(createdAt: string | undefined, now: number): number | null {
  if (!createdAt) return null;
  const started = new Date(createdAt).getTime();
  if (Number.isNaN(started)) return null;
  return Math.max(0, Math.round((now - started) / 60000));
}

export function Dashboard({ onAddItems }: { onAddItems?: (tableId: string) => void } = {}) {
  const { can } = useAuth();
  const [tables, setTables] = useState<TableCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null,
  );
  const [busyTableId, setBusyTableId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [showAddTable, setShowAddTable] = useState(false);
  const [floors, setFloors] = useState<string[]>([]);
  const [tableMeta, setTableMeta] = useState<Record<string, { floor: string; capacity: number | null }>>({});
  const [activeFloor, setActiveFloor] = useState<string>('all');

  const [viewTableId, setViewTableId] = useState<string | null>(null);
  const [viewInvoiceNumber, setViewInvoiceNumber] = useState<string | null>(null);
  const [viewOrders, setViewOrders] = useState<{ id: string; orderNumber: number }[]>([]);
  const [viewItems, setViewItems] = useState<OrderDetailItem[]>([]);
  const [viewLog, setViewLog] = useState<OrderActivityLogEntry[]>([]);
  const [viewDiscounts, setViewDiscounts] = useState<OrderDiscountInfo[]>([]);
  const [viewLoading, setViewLoading] = useState(false);

  const [payingTable, setPayingTable] = useState<TableCard | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [cashAmount, setCashAmount] = useState('');
  const [cardAmount, setCardAmount] = useState('');
  const [upiAmount, setUpiAmount] = useState('');
  const [savingPayment, setSavingPayment] = useState(false);

  useEffect(() => {
    load();
    loadMeta();
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const result = await window.api.listTables();
      setTables(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tables');
    } finally {
      setLoading(false);
    }
  }

  // Best-effort: floor + seats per table for the floor tabs / footer. Never blocks the page.
  async function loadMeta() {
    try {
      const all = await window.api.listManagedTables();
      const meta: Record<string, { floor: string; capacity: number | null }> = {};
      for (const t of all) meta[t.tableId] = { floor: t.floor || '', capacity: t.capacity };
      setTableMeta(meta);
    } catch {
      setTableMeta({});
    }
  }

  function flash(type: 'success' | 'error', text: string) {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  }

  async function handlePrint(table: TableCard) {
    if (!table.tableId) return;
    try {
      setBusyTableId(table.tableId);
      // Grouped reprint: pulls in every order still in this table's batch
      // (all rounds settled together) so a reprint after grouping still
      // shows the full merged bill, not just one order.
      await window.api.reprintTableBill(table.tableId);
      flash('success', `Printed for Table ${table.tableNumber}`);
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Print failed');
    } finally {
      setBusyTableId(null);
    }
  }

  function openPaymentDialog(table: TableCard) {
    setPayingTable(table);
    setPaymentMethod('cash');
    setCashAmount('');
    setCardAmount('');
    setUpiAmount('');
  }

  function closePaymentDialog() {
    setPayingTable(null);
  }

  const partPaymentSum =
    (Number(cashAmount) || 0) + (Number(cardAmount) || 0) + (Number(upiAmount) || 0);
  const partPaymentMatches =
    payingTable != null &&
    Math.round(partPaymentSum * 100) === Math.round((payingTable.orderTotalAmount ?? 0) * 100);

  async function handleSavePayment() {
    if (!payingTable?.invoiceNumber) return;

    if (paymentMethod === 'part-payment' && !partPaymentMatches) {
      flash(
        'error',
        `Cash + Card + UPI (${formatCurrency(partPaymentSum)}) must equal the order total (${formatCurrency(
          payingTable.orderTotalAmount ?? 0,
        )})`,
      );
      return;
    }

    try {
      setSavingPayment(true);
      await window.api.savePayment({
        invoiceNumber: payingTable.invoiceNumber,
        method: paymentMethod,
        cashAmount: paymentMethod === 'part-payment' ? Number(cashAmount) || 0 : undefined,
        cardAmount: paymentMethod === 'part-payment' ? Number(cardAmount) || 0 : undefined,
        upiAmount: paymentMethod === 'part-payment' ? Number(upiAmount) || 0 : undefined,
      });
      flash('success', `Payment recorded for Table ${payingTable.tableNumber} — table released`);
      closePaymentDialog();
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to save payment');
    } finally {
      setSavingPayment(false);
    }
  }

  async function handleRefresh() {
    try {
      setRefreshing(true);
      setMessage(null);
      const result = await window.api.listTables();
      setTables(result);
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Refresh failed' });
    } finally {
      setRefreshing(false);
    }
  }
  
  async function openAddTable() {
    setShowAddTable(true);
    try {
      // Best-effort: floor suggestions for the shared form. Never blocks adding.
      const all = await window.api.listManagedTables();
      setFloors(Array.from(new Set(all.map((t) => t.floor).filter(Boolean))).sort());
    } catch {
      setFloors([]);
    }
  }

  async function handleAddTable(payload: SaveManagedTablePayload): Promise<void> {
    await window.api.saveManagedTable(payload); // throws -> shown inside the modal
    setShowAddTable(false);
    flash('success', `Table ${payload.tableNumber} added`);
    void loadMeta();
    try {
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Added, but failed to refresh');
    }
  }

  // Detail is fetched by invoice number (shared by every round of the table's
  // current sitting), the same path the Orders List uses.
  async function fetchView(invoiceNumber: string) {
    const [detail, log] = await Promise.all([
      window.api.getInvoiceOrderDetail(invoiceNumber),
      window.api.getInvoiceActivityLog(invoiceNumber),
    ]);
    setViewOrders(detail.orders);
    setViewItems(detail.items);
    setViewDiscounts(detail.discounts ?? []);
    setViewLog(log);
  }

  async function openView(table: TableCard) {
    if (!table.tableId) return;
    if (!table.invoiceNumber) {
      flash('error', 'This order has no invoice number, so its details cannot be loaded.');
      return;
    }
    setViewTableId(table.tableId);
    setViewInvoiceNumber(table.invoiceNumber);
    try {
      setViewLoading(true);
      await fetchView(table.invoiceNumber);
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to load order');
      closeView();
    } finally {
      setViewLoading(false);
    }
  }

  function closeView() {
    setViewTableId(null);
    setViewInvoiceNumber(null);
    setViewOrders([]);
    setViewItems([]);
    setViewLog([]);
    setViewDiscounts([]);
  }

  async function refreshView() {
    if (!viewInvoiceNumber) return;
    await fetchView(viewInvoiceNumber);
    await load();
  }

  // Write errors (e.g. wrong editor credentials) propagate to ApprovalModal;
  // a refresh failure after a successful write is flashed separately.
  async function refreshAfterWrite(): Promise<void> {
    try {
      await refreshView();
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

  async function handleDiscount(
    orderIds: string[],
    mode: OrderDiscountMode,
    value: number | undefined,
    reason: string,
  ): Promise<void> {
    await window.api.setOrderDiscount({ orderIds, mode, value, reason });
    flash('success', mode === 'none' ? 'Discount removed' : mode === 'complimentary' ? 'Marked complimentary' : 'Discount applied');
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

  const viewingTable = useMemo(
    () => tables.find((t) => t.tableId === viewTableId),
    [tables, viewTableId],
  );

  const floorTabs = useMemo(
    () => Array.from(new Set(tables.map((t) => tableMeta[t.tableId]?.floor).filter(Boolean) as string[])).sort(),
    [tables, tableMeta],
  );
  const visibleTables = useMemo(
    () =>
      activeFloor === 'all'
        ? tables
        : tables.filter((t) => tableMeta[t.tableId]?.floor === activeFloor),
    [tables, tableMeta, activeFloor],
  );
  // Footer stats for the visible floor.
  const occupiedCount = visibleTables.filter((t) => t.cardStatus !== 'available').length;
  const totalSeats = visibleTables.reduce((n, t) => n + (tableMeta[t.tableId]?.capacity ?? 0), 0);
  const takenSeats = visibleTables
    .filter((t) => t.cardStatus !== 'available')
    .reduce((n, t) => n + (tableMeta[t.tableId]?.capacity ?? 0), 0);
  const occupancyPct = visibleTables.length
    ? Math.round((occupiedCount / visibleTables.length) * 100)
    : 0;

  function statusOf(t: TableCard): { key: string; label: string } {
    if (t.cardStatus === 'active') return { key: 'active', label: 'Ordered' };
    if (t.cardStatus === 'settled') {
      return t.paymentRecorded
        ? { key: 'settled', label: 'Paid' }
        : { key: 'settled', label: 'Occupied & Unpaid' };
    }
    // if (t.manualStatus !== 'available') {
    //   return { key: 'manual_' + t.manualStatus, label: t.manualStatus };
    // }
    return { key: 'available', label: 'Available' };
  }

  return (
    <div className={styles.page}>
      <div className={styles.main}>
        <div className={styles.header}>
          <h2>Dining</h2>
        
        <div className={styles.actionButtons}>
          <button className={styles.refreshBtn} onClick={handleRefresh} disabled={refreshing}>
          <Icon name="refresh" size={16} />
          {refreshing ? 'Refreshing…' : 'Refresh Tables'}
        </button>
          {can('tables.manage') && (
            <button className={styles.addBtn} onClick={openAddTable}>
              <Icon name="plus" size={16} />
              Add Table
            </button>
          )}
        </div>
        </div>

        <div className={styles.toolbar}>
          <div className={styles.floorTabs}>
            <button
              className={`${styles.floorTab} ${activeFloor === 'all' ? styles.floorTabOn : ''}`}
              onClick={() => setActiveFloor('all')}
            >
              All
            </button>
            {floorTabs.map((f) => (
              <button
                key={f}
                className={`${styles.floorTab} ${activeFloor === f ? styles.floorTabOn : ''}`}
                onClick={() => setActiveFloor(f)}
              >
                {f}
              </button>
            ))}
          </div>
          <div className={styles.legend}>
            <span><i className={`${styles.dot} ${styles.dotAvailable}`} />Available</span>
            <span><i className={`${styles.dot} ${styles.dotActive}`} />Ordered</span>
            <span><i className={`${styles.dot} ${styles.dotSettled}`} />Occupied</span>
            <span><i className={`${styles.dot} ${styles.dotReserved}`} />Reserved</span>
          </div>
        </div>
        <Toast message={message} />
        {error && <p className={styles.error}>{error}</p>}
        {loading && <p className={styles.muted}>Loading tables…</p>}

        {!loading && !error && tables.length === 0 && (
          <p className={styles.muted}>No tables yet — add one to get started.</p>
        )}

      <div className={styles.canvas}>
      <div className={styles.grid}>
        {visibleTables.map((table) => {
            const mins = elapsedMinutes(table.orderCreatedAt, now);
            const st = statusOf(table);
            const cap = tableMeta[table.tableId]?.capacity ?? 0;
            const busy = busyTableId === table.tableId;
          return (
            <div
                  key={table.tableId}
                  className={`${styles.card} ${styles[st.key] ?? ''}`}
                >
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
                        {startedAt(table.orderCreatedAt)}
                        {mins !== null ? ` · ${mins} min` : ''}
                      </div>
                    )}
                    {table.cardStatus !== 'available' && (
                      <div className={styles.cardAmount}>{formatCurrency(table.orderTotalAmount ?? 0)}</div>
                    )}
                  </div>
                  <div className={styles.cardActions}>
                    {(table.cardStatus === 'available' || table.cardStatus === 'active') &&(
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
                    {table.cardStatus === 'settled' && (
                        <button
                          className={styles.iconBtn}
                          title={table.cardStatus === 'settled' ? 'Print Duplicate Bill' : 'Print Bill'}
                          onClick={() => handlePrint(table)}
                          disabled={busyTableId === table.tableId}
                        >
                          <Icon name="print" size={16} />
                        </button>
                        )}
                        {table.cardStatus === 'active' && (
                        <button
                          className={styles.iconBtn}
                          title="View details"
                          onClick={() => openView(table)}
                          disabled={busyTableId === table.tableId}
                        >
                          <Icon name="view" size={16} />
                        </button>
                        )}
                        {table.cardStatus === 'settled' && !table.paymentRecorded && can('orders.complete') && (
                          <button
                            className={styles.iconBtn}
                            title="Record Payment (required to release this table)"
                            onClick={() => openPaymentDialog(table)}
                            disabled={busyTableId === table.tableId}
                          >
                            <Icon name="save" size={16} />
                          </button>
                        )}
                  
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className={styles.footer}>
          <span>
            <b>{occupiedCount}</b> / {visibleTables.length} tables occupied
          </span>
          {totalSeats > 0 && (
            <span>
              <b>{takenSeats}</b> / {totalSeats} seats
            </span>
          )}
          <div className={styles.progress}>
            <div className={styles.progressFill} style={{ width: `${occupancyPct}%` }} />
          </div>
          <span className={styles.pct}>{occupancyPct}%</span>
        </div>
      </div>


      {showAddTable && (
        <TableFormModal
          floors={floors}
          onSave={handleAddTable}
          onClose={() => setShowAddTable(false)}
        />
      )}

      {payingTable && (
        <div className={styles.modalOverlay} onClick={closePaymentDialog}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>
              Table {payingTable.tableNumber} · {formatCurrency(payingTable.orderTotalAmount ?? 0)}
            </h3>
            {payingTable.orderNumbers && payingTable.orderNumbers.length > 1 && (
              <p className={styles.muted}>Orders: {payingTable.orderNumbers.join(', ')}</p>
            )}

            <div className={styles.paymentOptions}>
              {PAYMENT_METHODS.map((m) => (
                <label key={m.value} className={styles.radioLabel}>
                  <input
                    type="radio"
                    name="paymentMethod"
                    value={m.value}
                    checked={paymentMethod === m.value}
                    onChange={() => setPaymentMethod(m.value)}
                  />
                  {m.label}
                </label>
              ))}
            </div>

            {paymentMethod === 'part-payment' && (
              <div className={styles.partPaymentFields}>
                <label className={styles.formLabel}>
                  Cash
                  <input
                    type="number"
                    value={cashAmount}
                    onChange={(e) => setCashAmount(e.target.value)}
                    placeholder="0.00"
                  />
                </label>
                <label className={styles.formLabel}>
                  Card
                  <input
                    type="number"
                    value={cardAmount}
                    onChange={(e) => setCardAmount(e.target.value)}
                    placeholder="0.00"
                  />
                </label>
                <label className={styles.formLabel}>
                  UPI
                  <input
                    type="number"
                    value={upiAmount}
                    onChange={(e) => setUpiAmount(e.target.value)}
                    placeholder="0.00"
                  />
                </label>
                <p className={partPaymentMatches ? styles.sumOk : styles.sumMismatch}>
                  Total entered: {formatCurrency(partPaymentSum)} / {formatCurrency(
                    payingTable.orderTotalAmount ?? 0,
                  )}
                </p>
              </div>
            )}

            <div className={styles.modalActions}>
              <button className={styles.cancelBtn} onClick={closePaymentDialog}>
                Cancel
              </button>
              <button
                className={styles.saveBtn}
                onClick={handleSavePayment}
                disabled={savingPayment || (paymentMethod === 'part-payment' && !partPaymentMatches)}
              >
                {savingPayment ? 'Saving…' : 'Save Payment'}
              </button>
            </div>
          </div>
        </div>
      )}

      {viewTableId && (
        <OrderDetailModal
          title={`Table ${viewingTable?.tableNumber ?? ''}`}
          headerAmount={viewingTable?.orderTotalAmount ?? 0}
          orders={viewOrders}
          discounts={viewDiscounts}
          items={viewItems}
          log={viewLog}
          loading={viewLoading}
          editable
          onClose={closeView}
          onDiscount={handleDiscount}
          onAddItems={
            onAddItems && viewingTable ? () => onAddItems(viewingTable.tableId) : undefined
          }
          discountSummary={{
            discountAmount: viewingTable?.orderDiscountAmount ?? 0,
            totalAmount: viewingTable?.orderTotalAmount ?? 0,
            discountPercent: 0,
          }}
          onEditItem={handleEditItem}
          onDeleteItem={handleDeleteItem}
          onMessage={flash}
        />
      )}
    </div>
  );
}
