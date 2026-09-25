import { Fragment, useEffect, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import type {
  TableCard,
  OrderDetailItem,
  OrderActivityLogEntry,
  PaymentMethod,
} from '@shared/types';
import styles from '../styles/TableDashboard.module.css';

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'card', label: 'Card' },
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'part-payment', label: 'Part Payment' },
];

function formatCurrency(n: number): string {
  return `₹ ${n.toFixed(2)}`;
}

function elapsedMinutes(createdAt: string | undefined, now: number): number | null {
  if (!createdAt) return null;
  const started = new Date(createdAt).getTime();
  if (Number.isNaN(started)) return null;
  return Math.max(0, Math.round((now - started) / 60000));
}

export function Dashboard() {
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
  const [newTableNumber, setNewTableNumber] = useState('');
  const [adding, setAdding] = useState(false);

  const [viewOrderId, setViewOrderId] = useState<string | null>(null);
  const [viewOrders, setViewOrders] = useState<{ id: string; orderNumber: number }[]>([]);
  const [viewItems, setViewItems] = useState<OrderDetailItem[]>([]);
  const [viewLog, setViewLog] = useState<OrderActivityLogEntry[]>([]);
  const [viewLoading, setViewLoading] = useState(false);
  const [editing, setEditing] = useState<{ id: string; quantity: string } | null>(null);

  const [payingTable, setPayingTable] = useState<TableCard | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [cashAmount, setCashAmount] = useState('');
  const [cardAmount, setCardAmount] = useState('');
  const [upiAmount, setUpiAmount] = useState('');
  const [savingPayment, setSavingPayment] = useState(false);

  useEffect(() => {
    load();
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

  function flash(type: 'success' | 'error', text: string) {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  }

  async function handlePrint(table: TableCard) {
    if (!table.orderId) return;
    try {
      setBusyTableId(table.tableId);
      // Grouped reprint: pulls in every order still in this table's batch
      // (all rounds settled together) so a reprint after grouping still
      // shows the full merged bill, not just one order.
      await window.api.reprintTableBill(table.orderId);
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
    if (!payingTable?.orderId) return;

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
        orderId: payingTable.orderId,
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

  async function handleAddTable() {
    if (!newTableNumber.trim()) {
      flash('error', 'Enter a table number');
      return;
    }
    try {
      setAdding(true);
      await window.api.createTable(newTableNumber.trim());
      setNewTableNumber('');
      setShowAddTable(false);
      flash('success', `Table ${newTableNumber.trim()} added`);
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to add table');
    } finally {
      setAdding(false);
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

  async function openView(table: TableCard) {
    if (!table.orderId) return;
    setViewOrderId(table.orderId);
    setEditing(null);
    try {
      setViewLoading(true);
      // Grouped: pulls in every order still open on this table, not just the
      // one the card happened to carry.
      const [detail, log] = await Promise.all([
        window.api.getTableOrderDetail(table.orderId),
        window.api.getTableActivityLog(table.orderId),
      ]);
      setViewOrders(detail.orders);
      setViewItems(detail.items);
      setViewLog(log);
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to load order');
      setViewOrderId(null);
    } finally {
      setViewLoading(false);
    }
  }

  function closeView() {
    setViewOrderId(null);
    setViewOrders([]);
    setViewItems([]);
    setViewLog([]);
    setEditing(null);
  }

  async function refreshView() {
    if (!viewOrderId) return;
    const [detail, log] = await Promise.all([
      window.api.getTableOrderDetail(viewOrderId),
      window.api.getTableActivityLog(viewOrderId),
    ]);
    setViewOrders(detail.orders);
    setViewItems(detail.items);
    setViewLog(log);
    await load();
  }

  async function saveEdit() {
    if (!editing) return;
    const quantity = Number(editing.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      flash('error', 'Quantity must be a positive number');
      return;
    }
    try {
      await window.api.editOrderItem({ orderItemId: editing.id, quantity });
      setEditing(null);
      await refreshView();
      flash('success', 'Item updated');
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to update item');
    }
  }

  async function removeItem(item: OrderDetailItem) {
    if (!confirm(`Remove "${item.name}" from this order?`)) return;
    try {
      await window.api.deleteOrderItem(item.orderItemId);
      await refreshView();
      flash('success', 'Item removed');
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to remove item');
    }
  }

  const viewingTable = useMemo(
    () => tables.find((t) => t.orderId === viewOrderId),
    [tables, viewOrderId],
  );

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h2>Dining</h2>
        </div>
        <div className={styles.actionButtons}>
          <button className={styles.refreshBtn} onClick={handleRefresh} disabled={refreshing}>
          <Icon name="refresh" size={16} />
          {refreshing ? 'Refreshing…' : 'Refresh Tables'}
        </button>
        <button className={styles.addBtn} onClick={() => setShowAddTable(true)}>
          <Icon name="plus" size={16} />
          Add Table
        </button>
        </div>

      {message && (
        <p className={message.type === 'error' ? styles.error : styles.success}>{message.text}</p>
      )}
      {error && <p className={styles.error}>{error}</p>}
      {loading && <p className={styles.muted}>Loading tables…</p>}

      {!loading && !error && tables.length === 0 && (
        <p className={styles.muted}>No tables yet — add one to get started.</p>
      )}

      <div className={styles.grid}>
        {tables.map((table) => {
          const mins = elapsedMinutes(table.orderCreatedAt, now);
          const busy = busyTableId === table.tableId;
          return (
            <div key={table.tableId} className={`${styles.card} ${styles[table.cardStatus]} ${styles[table.tableState]}`}>
              {table.tableState === 'available' ? (
                <div className={styles.availableBody}>
                  <div className={styles.tableNumber}>{table.tableNumber}</div>
                  <div className={styles.availableLabel}>Available</div>
                </div>
              ) : (
                <>
                  <div className={styles.cardTop}>
                    {mins !== null && <div className={styles.minutes}>{mins} Min</div>}
                    <div className={styles.tableNumber}>{table.tableNumber}</div>
                    <div className={styles.tableNumber}>{table.tableState}</div>
                    <div className={styles.amount}>{formatCurrency(table.orderTotalAmount ?? 0)}</div>
                  </div>

                  {table.orderNumbers && table.orderNumbers.length > 1 && (
                    <div className={styles.orderNumbers}>
                      Orders: {table.orderNumbers.join(', ')}
                    </div>
                  )}

                  <div className={styles.cardActions}>
                    <button
                      className={styles.iconBtn}
                      title={table.cardStatus === 'settled' ? 'Print Duplicate Bill' : 'Print Bill'}
                      onClick={() => handlePrint(table)}
                      disabled={busy}
                    >
                      <Icon name="print" size={18} />
                    </button>
                    {table.cardStatus === 'active' && (
                      <button
                        className={styles.iconBtn}
                        title="View Items"
                        onClick={() => openView(table)}
                        disabled={busy}
                      >
                        <Icon name="view" size={18} />
                      </button>
                    )}
                    {table.cardStatus === 'settled' && !table.paymentRecorded && (
                      <button
                        className={styles.iconBtn}
                        title="Record Payment (required to release this table)"
                        onClick={() => openPaymentDialog(table)}
                        disabled={busy}
                      >
                        <Icon name="save" size={18} />
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {showAddTable && (
        <div className={styles.modalOverlay} onClick={() => setShowAddTable(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>Add Table</h3>
            <label className={styles.formLabel}>
              Table Number
              <input
                type="text"
                value={newTableNumber}
                onChange={(e) => setNewTableNumber(e.target.value)}
                placeholder="e.g. 12"
                autoFocus
              />
            </label>
            <div className={styles.modalActions}>
              <button className={styles.cancelBtn} onClick={() => setShowAddTable(false)}>
                Cancel
              </button>
              <button className={styles.saveBtn} onClick={handleAddTable} disabled={adding}>
                {adding ? 'Adding…' : 'Add Table'}
              </button>
            </div>
          </div>
            </div>
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

      {viewOrderId && (
        <div className={styles.modalOverlay} onClick={closeView}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3>
              Table {viewingTable?.tableNumber ?? ''}
              {viewingTable && ` · ${formatCurrency(viewingTable.orderTotalAmount ?? 0)}`}
            </h3>
            {viewOrders.length > 1 && (
              <p className={styles.muted}>
                Orders: {viewOrders.map((o) => o.orderNumber).join(', ')}
              </p>
            )}

            {viewLoading ? (
              <p className={styles.muted}>Loading…</p>
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
                  {viewItems.map((item, idx) => {
                    const showOrderHeader =
                      viewOrders.length > 1 &&
                      item.orderNumber !== undefined &&
                      viewItems[idx - 1]?.orderNumber !== item.orderNumber;
                    return (
                      <Fragment key={item.orderItemId}>
                        {showOrderHeader && (
                          <tr className={styles.groupHeaderRow}>
                            <td colSpan={5}>Order #{item.orderNumber}</td>
                          </tr>
                        )}
                        <tr className={item.isDeleted ? styles.deletedRow : undefined}>
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
                            {!item.isDeleted && item.editedAt && <span className={styles.tag}>edited</span>}
                          </td>
                          <td>{item.quantity}</td>
                          <td>{formatCurrency(item.unitPrice)}</td>
                          <td>{formatCurrency(item.totalPrice)}</td>
                          <td className={styles.itemActions}>
                            {!item.isDeleted && (
                              <>
                                <button
                                  className={styles.smallBtn}
                                  onClick={() =>
                                    setEditing({ id: item.orderItemId, quantity: String(item.quantity) })
                                  }
                                >
                                  Edit
                                </button>
                                <button className={styles.smallBtnDanger} onClick={() => removeItem(item)}>
                                  Remove
                                </button>
                              </>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}

            {!viewLoading && (
              <>
                <h4 className={styles.logHeading}>Activity Log</h4>
                {viewLog.length === 0 ? (
                  <p className={styles.muted}>No items have been edited or removed.</p>
                ) : (
                  <table className={styles.itemsTable}>
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th>Action</th>
                        <th>Reason</th>
                        <th>By</th>
                      </tr>
                    </thead>
                    <tbody>
                      {viewLog
                        .slice()
                        .reverse()
                        .map((entry) => (
                          <tr key={entry.auditId}>
                            <td>{entry.itemName}</td>
                            <td>{entry.action === 'delete' ? 'Removed' : 'Modified'}</td>
                            <td>{entry.reason || '—'}</td>
                            <td>{entry.changedByName}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
              </>
            )}

            <div className={styles.modalActions}>
              <button className={styles.cancelBtn} onClick={closeView}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
