import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
//import { KitchenPill } from './KitchenPill';
import { OrderDetailModal } from './OrderDetailModal';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
//import { DEFAULT_KOT_STEPS, type KotLevel } from '../lib/kitchen';
import { formatMoney } from '../lib/format';
import {
  type ActiveTakeawayOrder,
  type OrderDetailItem,
  type OrderActivityLogEntry,
  type OrderDiscountInfo,
  type OrderDiscountMode,
  type EditorApproval,
  PICK_UP_ORDER_TYPE,
  DELIVERY_ORDER_TYPE,
} from '@shared/types';
import styles from '../styles/TakeawayBoard.module.css';

function timeOf(createdAt: string): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function minutesSince(createdAt: string, now: number): number | null {
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now - t) / 60000));
}

function typeLabel(orderType: string): string {
  if (orderType === DELIVERY_ORDER_TYPE) return 'Delivery';
  if (orderType === PICK_UP_ORDER_TYPE) return 'Takeaway';
  return 'Dine In';
}

export function orderTitle(o: ActiveTakeawayOrder): string {
  return o.orderNumber!='' ? `Order #${o.orderNumber}` : `Order ${o.orderId.slice(0, 8)}`;
}

/**
 * Dashboard > Takeaway: open takeaway / pickup / delivery orders as cards, oldest
 * first, with Print bill, View / edit and Complete. The list itself is read by
 * the Dashboard (`useActiveTakeaway`) so the tab can show a count. See
 * docs/DASHBOARD_TAKEAWAY.md.
 */
export function TakeawayBoard({
  orders,
  loading,
  error,
  truncated,
  onReload,
  onMessage,
}: {
  orders: ActiveTakeawayOrder[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  onReload: () => Promise<void>;
  onMessage: (type: 'success' | 'error', text: string) => void;
}) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<string | null>(null);
  // const [kotSteps, setKotSteps] = useState<OrderKotStep[]>(DEFAULT_KOT_STEPS);
  // const [kotLevels, setKotLevels] = useState<KotLevel[]>([]);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);

  const [viewId, setViewId] = useState<string | null>(null);
  const [viewInvoice, setViewInvoice] = useState<string | null>(null);
  const [viewOrders, setViewOrders] = useState<{ id: string; orderNumber: number }[]>([]);
  const [viewItems, setViewItems] = useState<OrderDetailItem[]>([]);
  const [viewLog, setViewLog] = useState<OrderActivityLogEntry[]>([]);
  const [viewDiscounts, setViewDiscounts] = useState<OrderDiscountInfo[]>([]);
  const [viewLoading, setViewLoading] = useState(false);

  // useEffect(() => {
  //   const tick = setInterval(() => setNow(Date.now()), 30_000);
  //   window.api
  //     .getOrderKotSetup()
  //     .then((s) => {
  //       if (s.steps.length > 0) setKotSteps(s.steps);
  //       setKotLevels(s.levels);
  //     })
  //     .catch(() => undefined); // keep the default steps
  //   return () => clearInterval(tick);
  // }, []);

  useEffect(() => {
    const serverNow = orders.find((o) => o.kitchen?.now)?.kitchen?.now;
    if (serverNow) setClockOffsetMs(new Date(serverNow).getTime() - Date.now());
  }, [orders]);

  async function handlePrint(o: ActiveTakeawayOrder) {
    try {
      setBusyId(o.orderId);
      // Same as the Orders list: the first print is the bill, any later one says DUPLICATE BILL.
      await window.api.reprintOrder(o.orderId);
      onMessage('success', `Bill sent to printer for ${orderTitle(o)}`);
    } catch (err) {
      onMessage('error', err instanceof Error ? err.message : 'Print failed');
    } finally {
      setBusyId(null);
    }
  }

  async function handleComplete(o: ActiveTakeawayOrder) {
    const who = o.customerName ? ` for ${o.customerName}` : '';
    if (
      !(await confirm({
        title: 'Complete order',
        message: `Mark ${orderTitle(o)}${who} (${formatMoney(o.totalAmount)}) as completed? It leaves this list.`,
        confirmLabel: 'Complete',
      }))
    )
      return;
    try {
      setBusyId(o.orderId);
      if (o.invoiceNumber) await window.api.completeInvoice(o.invoiceNumber);
      else await window.api.completeOrder(o.orderId);
      onMessage('success', `${orderTitle(o)} completed`);
    } catch (err) {
      onMessage('error', err instanceof Error ? err.message : 'Failed to complete order');
    } finally {
      setBusyId(null);
    }
    await onReload();
  }

  async function fetchView(invoiceNumber: string) {
    const [detail] = await Promise.all([
      window.api.getInvoiceOrderDetail(invoiceNumber),
      //window.api.getInvoiceActivityLog(invoiceNumber),
    ]);
    setViewOrders(detail.orders);
    setViewItems(detail.items);
    setViewDiscounts(detail.discounts ?? []);
    setViewLog(detail.log ?? []);
  }

  async function openView(o: ActiveTakeawayOrder) {
    if (!o.invoiceNumber) {
      onMessage('error', 'This order has no invoice number, so its details cannot be loaded.');
      return;
    }
    setViewId(o.orderId);
    setViewInvoice(o.invoiceNumber);
    try {
      setViewLoading(true);
      await fetchView(o.invoiceNumber);
    } catch (err) {
      onMessage('error', err instanceof Error ? err.message : 'Failed to load order');
      closeView();
    } finally {
      setViewLoading(false);
    }
  }

  function closeView() {
    setViewId(null);
    setViewInvoice(null);
    setViewOrders([]);
    setViewItems([]);
    setViewLog([]);
    setViewDiscounts([]);
  }

  // Write errors go back to the approval / discount dialog; a refresh failure after a good write is flashed.
  async function refreshAfterWrite(): Promise<void> {
    try {
      if (viewInvoice) await fetchView(viewInvoice);
      await onReload();
    } catch (err) {
      onMessage('error', err instanceof Error ? err.message : 'Saved, but failed to refresh');
    }
  }

  async function handleEditItem(orderItemId: string, quantity: number, reason: string, approval: EditorApproval) {
    await window.api.editOrderItem({ orderItemId, quantity, reason, approval });
    onMessage('success', 'Item updated');
    await refreshAfterWrite();
  }

  async function handleDeleteItem(item: OrderDetailItem, reason: string, approval: EditorApproval) {
    await window.api.deleteOrderItem(item.orderItemId, reason, approval);
    onMessage('success', 'Item removed');
    await refreshAfterWrite();
  }

  async function handleDiscount(orderIds: string[], mode: OrderDiscountMode, value: number | undefined, reason: string) {
    await window.api.setOrderDiscount({ orderIds, mode, value, reason });
    onMessage('success', mode === 'none' ? 'Discount removed' : mode === 'complimentary' ? 'Marked complimentary' : 'Discount applied');
    await refreshAfterWrite();
  }

  const viewing = useMemo(() => orders.find((o) => o.orderId === viewId), [orders, viewId]);
  const canEdit = can('orders.edit');

  return (
    <>
      {error && <p className={styles.error}>Could not refresh takeaway orders: {error}</p>}
      {loading && orders.length === 0 && <p className={styles.muted}>Loading takeaway orders…</p>}

      <div className={styles.canvas}>
        {!loading && orders.length === 0 && !error && (
          <p className={styles.empty}>No open takeaway orders. Orders placed from New order &gt; Pickup show here until they are completed or cancelled.</p>
        )}
        <div className={styles.grid}>
          {orders.map((o) => {
            const mins = minutesSince(o.createdAt, now);
            const busy = busyId === o.orderId;
            return (
              <div key={o.orderId} className={`${styles.card} ${o.orderType === 'delivery' ? styles.delivery : ''}`}>
                <span className={styles.accent} />
                <div className={styles.topRow}>
                  <div className={styles.title}>{orderTitle(o)}</div>
                  <div className={styles.badges}>
                    {o.orderType === 'delivery' && <span className={styles.badge}>{typeLabel(o.orderType)}</span>}
                    {o.orderSource !== 'pos' && (
                      <span className={`${styles.badge} ${styles.badgeMobile}`}>
                        {o.orderSource === 'mobile' ? 'Phone' : 'POS + Phone'}
                      </span>
                    )}
                  </div>
                </div>
                <div className={styles.customer} title={o.customerPhone ?? undefined}>
                  {o.customerName || 'No name'}
                  {o.customerPhone && <span className={styles.phone}> · {o.customerPhone}</span>}
                </div>
                <div className={styles.meta}>
                  {timeOf(o.createdAt)}
                  {mins !== null ? ` · ${mins} min` : ''} · {o.itemCount} item{o.itemCount === 1 ? '' : 's'}
                </div>
                <div className={styles.bottomRow}>
                  {/* <KitchenPill kitchen={o.kitchen} steps={kotSteps} status={o.status} levels={kotLevels} clockOffsetMs={clockOffsetMs} /> */}
                  <div className={styles.amount}>
                    {formatMoney(o.totalAmount)}
                    {o.discountAmount > 0 && <span className={styles.discount} title="Discount applied"> −{formatMoney(o.discountAmount)}</span>}
                  </div>
                </div>
                <div className={styles.actions}>
                  <button className={styles.iconBtn} title="Print Bill" onClick={() => handlePrint(o)} disabled={busy}>
                    <Icon name="print" size={16} />
                  </button>
                  <button
                    className={styles.iconBtn}
                    title={canEdit ? 'View / Edit Items' : 'View details'}
                    onClick={() => openView(o)}
                    disabled={busy}
                  >
                    <Icon name={canEdit ? 'edit' : 'view'} size={16} />
                  </button>
                  {can('orders.complete') && (
                    <button
                      className={`${styles.iconBtn} ${styles.completeBtn}`}
                      title="Complete (handed over and paid)"
                      onClick={() => handleComplete(o)}
                      disabled={busy}
                    >
                      <Icon name="check" size={16} />
                      <span>Complete</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {truncated && (
          <p className={styles.muted}>Only the first 200 open orders are shown. The Orders list has every order.</p>
        )}
      </div>

      {viewId && (
        <OrderDetailModal
          title={viewing ? `${orderTitle(viewing)}${viewing.customerName ? ` · ${viewing.customerName}` : ''}` : 'Order'}
          headerAmount={viewing?.totalAmount}
          orders={viewOrders}
          discounts={viewDiscounts}
          meta={viewing ? { orderType: viewing.orderType, status: viewing.status, invoiceNumber: viewing.invoiceNumber, date: viewing.createdAt } : undefined}
          totals={
            viewing
              ? {
                  subtotalAmount: viewing.subtotalAmount,
                  taxAmount: viewing.taxAmount,
                  containerChargeAmount: viewing.containerChargeAmount,
                  discountAmount: viewing.discountAmount,
                  totalAmount: viewing.totalAmount,
                  orderType: viewing.orderType,
                  discountValue: viewing.discountAmount,
                }
              : undefined
          }
          items={viewItems}
          log={viewLog}
          loading={viewLoading}
          editable={viewing?.status === 'open'}
          onClose={closeView}
          onDiscount={handleDiscount}
          onEditItem={handleEditItem}
          onDeleteItem={handleDeleteItem}
          onMessage={onMessage}
        />
      )}
    </>
  );
}
