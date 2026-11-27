import { useEffect, useMemo, useRef, useState } from 'react';
import { useScreenTiming } from '../lib/timing';
import { Toast } from '../components/Toast';
import { Icon } from '../components/Icon';
import { OrderDetailModal } from '../components/OrderDetailModal';
import { useAuth } from '../context/AuthContext';
import { TableFormModal } from '../components/TableFormModal';
import { TakeawayBoard } from '../components/TakeawayBoard';
import { useActiveTakeaway } from '../hooks/useActiveTakeaway';
import {
  type TableCard,
  type OrderDetailItem,
  type PaymentMethod,
  type EditorApproval,
  type OrderDiscountMode,
  type OrderDiscountInfo,
  type SaveManagedTablePayload,
  PICK_UP_ORDER_TYPE,
  ManagedTable,
} from '@shared/types';
import styles from '../styles/TableDashboard.module.css';
import { formatMoney as formatCurrency } from '../lib/format';
import { useLiveChange } from '../hooks/useLiveChange';
import { useStableCallback } from '../hooks/useStableCallback';
import { TableCardView } from '../components/TableCardView';
import { cardKey, reuseUnchangedCards } from '../lib/tableCards';
import type { LiveChange } from '@shared/liveTypes';

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'card', label: 'Card' },
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'part-payment', label: 'Part Payment' },
];


type DashboardView = 'tables' | 'takeaway';
const VIEW_KEY = 'dashboard.view';

function savedView(): DashboardView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'takeaway' ? 'takeaway' : 'tables';
  } catch {
    return 'tables';
  }
}

type TableMeta = Record<string, { floor: string; capacity: number | null }>;

function sameMeta(a: TableMeta, b: TableMeta): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => b[k] && b[k].floor === a[k].floor && b[k].capacity === a[k].capacity);
}

/**
 * `onAddItems` opens New order for a table; `onNewTakeaway` opens a fresh New order
 * (Pickup). The caller passes them only when the user may place orders.
 * Dine-in tab speed notes: docs/DASHBOARD_TABLES.md.
 */
export function Dashboard({
  onAddItems,
  onNewTakeaway,
}: { onAddItems?: (tableId: string) => void; onNewTakeaway?: () => void } = {}) {
  const { can } = useAuth();
  // Takeaway tab: open takeaway / pickup / delivery orders (docs/DASHBOARD_TAKEAWAY.md). Needs orders.view.
  const canSeeTakeaway = can('orders.view');
  const [view, setView] = useState<DashboardView>(() => (savedView() === PICK_UP_ORDER_TYPE && canSeeTakeaway ? PICK_UP_ORDER_TYPE : 'tables'));
  const takeaway = useActiveTakeaway(canSeeTakeaway);
  const showTakeaway = view === PICK_UP_ORDER_TYPE && canSeeTakeaway;

  function chooseView(next: DashboardView) {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // remembering the tab is only a convenience
    }
    if (next === PICK_UP_ORDER_TYPE) void takeaway.reload();
  }

  const [tables, setTables] = useState<TableCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useScreenTiming('Dashboard', !loading, error !== null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null,
  );
  const [busyTableId, setBusyTableId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [showAddTable, setShowAddTable] = useState(false);
  const [floors, setFloors] = useState<string[]>([]);
  // Floor + seats per table. Normally they come with the tiles (listTables, one
  // call); listManagedTables is only the fallback for a database without
  // db/migrations/table_bills_floor.sql (docs/DASHBOARD_TABLES.md).
  const [fallbackMeta, setFallbackMeta] = useState<TableMeta>({});
  const cardsCarryMeta = useRef<boolean | null>(null);
  const [activeFloor, setActiveFloor] = useState<string>('all');

  const [viewTableId, setViewTableId] = useState<string | null>(null);
  const [viewInvoiceNumber, setViewInvoiceNumber] = useState<string | null>(null);
  const [viewOrders, setViewOrders] = useState<{ id: string; orderNumber: number }[]>([]);
  const [viewItems, setViewItems] = useState<OrderDetailItem[]>([]);
  const [viewDiscounts, setViewDiscounts] = useState<OrderDiscountInfo[]>([]);
  const [viewLoading, setViewLoading] = useState(false);

  const [payingTable, setPayingTable] = useState<TableCard | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [cashAmount, setCashAmount] = useState('');
  const [cardAmount, setCardAmount] = useState('');
  const [upiAmount, setUpiAmount] = useState('');
  const [savingPayment, setSavingPayment] = useState(false);

  useEffect(() => {
    // One round trip when the tiles carry floor and seats; else read them as before.
    void load().then(() => {
      if (cardsCarryMeta.current === false) void loadMeta();
    });
    // The 30 s "N min" tick lives in ElapsedMinutes, so it re-renders only those labels.
  }, []);

  // Live updates (docs/LIVE_UPDATES.md): a new or changed order or table, from
  // this PC, a phone or another PC, reloads the tiles in place. Unchanged tiles
  // keep their objects (reuseUnchangedCards), so only changed tiles re-render.
  // Floor and seats come with the same reload. Only on an older database
  // (fallback) are they read again, and then only when tables alone changed
  // (added, edited, switched on/off) or on the slow safety reload, not on every
  // order change (docs/DASHBOARD_TABLES.md).
  useLiveChange(['orders', 'tables'], (change: LiveChange) => {
    void load(true);
    if (cardsCarryMeta.current === false && (change.origin === 'safety' || !change.scopes.includes('orders'))) {
      void loadMeta();
    }
  });

  // quiet: refresh in place (no "Loading tables…" line), used after a print
  // and on live updates.
  async function load(quiet = false) {
    try {
      if (!quiet) setLoading(true);
      setError(null);
      const result = await window.api.listTables();
      // No tiles: nothing to learn; keep what we knew.
      if (result.length > 0) cardsCarryMeta.current = result[0].floor !== undefined;
      setTables((prev) => reuseUnchangedCards(prev, result));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tables');
    } finally {
      setLoading(false);
    }
  }

  // Fallback (older database): floor + seats from the tables list. Best-effort,
  // never blocks the page. Returns the list it read (Add Table uses it for the
  // floor suggestions).
  async function loadMeta(): Promise<ManagedTable[] | null> {
    try {
      const all = await window.api.listManagedTables();
      const meta: TableMeta = {};
      for (const t of all) meta[t.tableId] = { floor: t.floor || '', capacity: t.capacity};
      // Keep the old object when nothing changed, so the page does not re-render.
      setFallbackMeta((prev) => (sameMeta(prev, meta) ? prev : meta));
      return all;
    } catch {
      setFallbackMeta((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return null;
    }
  }

  function flash(type: 'success' | 'error', text: string) {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  }

  async function handlePrint(table: TableCard) {
    if (!table.tableId) return;
    try {
      setBusyTableId(cardKey(table));
      if (table.cardStatus === 'active') {
      // Grouped reprint: pulls in every order still in this table's batch
      // (all rounds settled together) so a reprint after grouping still
      // shows the full merged bill, not just one order.

      await Promise.all([
        window.api.reprintOrder(table.invoiceNumber!),
        window.api.completeInvoice(table.invoiceNumber!),
      ]); 
        flash('success', `Printed for Table ${table.tableNumber}`);
      }
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Print failed');
    } finally {
      setBusyTableId(null);
    }
    // Reload the tables so the card shows the new state (Occupied, payment
    // pending, after a settle). Also after a failure, in case the bill printed
    // but marking the orders completed did not finish.
    await load(true);
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
      const otherBills = tables.some((t) => t.tableId === payingTable.tableId && cardKey(t) !== cardKey(payingTable));
      flash(
        'success',
        otherBills
          ? `Payment recorded for Table ${payingTable.tableNumber} — its other bill is still open`
          : `Payment recorded for Table ${payingTable.tableNumber} — table released`,
      );
      //flash('success', `Payment recorded for Table ${payingTable.tableNumber} — table released`);
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
    // Best-effort: floor suggestions for the shared form (every table's floor,
    // inactive ones too). Never blocks adding.
    const all = await loadMeta();
    setFloors(all ? Array.from(new Set(all.map((t) => t.floor).filter(Boolean))).sort() : []);
  }

  async function handleAddTable(payload: SaveManagedTablePayload): Promise<void> {
    await window.api.saveManagedTable(payload); // throws -> shown inside the modal
    setShowAddTable(false);
    flash('success', `Table ${payload.tableNumber} added`);
    if (cardsCarryMeta.current !== true) void loadMeta();
    try {
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Added, but failed to refresh');
    }
  }

  // Detail is fetched by invoice number (shared by every round of the table's
  // current sitting), the same path the Orders List uses.
  // One call: rounds, items and discounts together; the activity log is read
  // only when "View activity" is tapped (see
  // getInvoiceOrderView in ordersListManager.ts).
  async function fetchView(invoiceNumber: string) {
    const detail = await window.api.getInvoiceOrderDetail(invoiceNumber);
     
    setViewOrders(detail.orders);
    setViewItems(detail.items);
    setViewDiscounts(detail.discounts ?? []);
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
    setViewDiscounts([]);
  }

  async function refreshView() {
    if (!viewInvoiceNumber) return;
    await Promise.all([fetchView(viewInvoiceNumber), load(true)]);
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

  // Stable identities for the memoized tiles (TableCardView): they always run
  // the latest handler, but never change, so a parent render skips unchanged tiles.
  const onTilePrint = useStableCallback((t: TableCard) => void handlePrint(t));
  const onTileView = useStableCallback((t: TableCard) => void openView(t));
  const onTilePay = useStableCallback(openPaymentDialog);
  const onTileAddItems = useStableCallback((tableId: string) => onAddItems?.(tableId));
  const canRecordPayment = can('orders.complete');

  const viewingTable = useMemo(
    () => tables.find((t) => t.tableId === viewTableId),
    [tables, viewTableId],
  );

    // From the tiles when they carry floor and seats, else the fallback read.
  const tableMeta = useMemo<TableMeta>(() => {
    if (!tables.some((t) => t.floor !== undefined)) return fallbackMeta;
    const meta: TableMeta = {};
    for (const t of tables) meta[t.tableId] = { floor: t.floor ?? '', capacity: t.capacity ?? null };
    return meta;
  }, [tables, fallbackMeta]);

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
  // A table can have two tiles: a printed bill waiting for payment and a running
  // bill (docs/TABLE_BILLS.md). Footer stats count tables, not tiles.
  const billCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tables) m.set(t.tableId, (m.get(t.tableId) ?? 0) + 1);
    return m;
  }, [tables]);
  const runningTableIds = useMemo(
    () => new Set(tables.filter((t) => t.cardStatus === 'active').map((t) => t.tableId)),
    [tables],
  );
  // Footer stats for the visible floor.
  const visibleTableIds = Array.from(new Set(visibleTables.map((t) => t.tableId)));
  const takenTableIds = new Set(visibleTables.filter((t) => t.cardStatus !== 'available').map((t) => t.tableId));
  const occupiedCount = takenTableIds.size;
  const totalSeats = visibleTableIds.reduce((n, id) => n + (tableMeta[id]?.capacity ?? 0), 0);
  const takenSeats = Array.from(takenTableIds).reduce((n, id) => n + (tableMeta[id]?.capacity ?? 0), 0);
  const occupancyPct = visibleTableIds.length
    ? Math.round((occupiedCount / visibleTableIds.length) * 100)
    : 0;

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

  return (
    <div className={styles.page}>
      <div className={styles.main}>
        <div className={styles.header}>
          {canSeeTakeaway && (
            <div className={styles.viewTabs} role="tablist" aria-label="Dashboard view">
              <button
                role="tab"
                aria-selected={!showTakeaway}
                className={`${styles.viewTab} ${!showTakeaway ? styles.viewTabOn : ''}`}
                onClick={() => chooseView('tables')}
              >
                <Icon name="table" size={16} />
                Tables
              </button>
              <button
                role="tab"
                aria-selected={showTakeaway}
                className={`${styles.viewTab} ${showTakeaway ? styles.viewTabOn : ''}`}
                onClick={() => chooseView('takeaway')}
              >
                <Icon name="menu" size={16} />
                Takeaway
                {takeaway.orders.length > 0 && <span className={styles.viewCount}>{takeaway.orders.length}</span>}
              </button>
            </div>
          )}
          {!showTakeaway && can('tables.manage') && (
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
          )}
          {showTakeaway && onNewTakeaway && (
            <button className={styles.addBtn} onClick={onNewTakeaway}>
              <Icon name="plus" size={16} />
              New takeaway
            </button>
          )}
        </div>

        {showTakeaway && (
          <>
            <Toast message={message} />
            <TakeawayBoard
              orders={takeaway.orders}
              loading={takeaway.loading}
              error={takeaway.error}
              truncated={takeaway.truncated}
              onReload={takeaway.reload}
              onMessage={flash}
            />
            <div className={styles.footer}>
              <span>
                <b>{takeaway.orders.length}</b> open takeaway order{takeaway.orders.length === 1 ? '' : 's'}
              </span>
              <span>
                <b>{formatCurrency(takeaway.orders.reduce((n:number, o:any) => n + o.totalAmount, 0))}</b> to collect
              </span>
              <span className={styles.footerSpacer} />
              <button
                className={styles.refreshBtn}
                onClick={() => void takeaway.reload()}
                title="Reload now (the list also updates by itself when an order changes)"
              >
                <Icon name="refresh" size={14} />
                Refresh
              </button>
              {takeaway.updatedAt && <span>Updated {takeaway.updatedAt.toLocaleTimeString()}</span>}
            </div>
          </>
        )}

        {!showTakeaway && (
        <>

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
            {visibleTables.map((table) => (
              <TableCardView
                key={cardKey(table)}
                table={table}
                capacity={tableMeta[table.tableId]?.capacity ?? 0}
                showBillNo={(billCount.get(table.tableId) ?? 0) > 1}
                hasRunningBill={runningTableIds.has(table.tableId)}
                busy={busyTableId === cardKey(table)}
                canRecordPayment={canRecordPayment}
                onAddItems={onAddItems ? onTileAddItems : undefined}
                onPrint={onTilePrint}
                onView={onTileView}
                onPay={onTilePay}
              />
            ))}
          </div>
        </div>

        <div className={styles.footer}>
          <span>
            <b>{occupiedCount}</b> / {visibleTableIds.length} tables occupied
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
        </>
        )}
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
          loadLog={() => window.api.getInvoiceActivityLog(viewingTable?.invoiceNumber!)}
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
