import { useState } from 'react';
import { OrderCard } from '../components/OrderCard';
import { OrderDetails } from '../components/OrderDetails';
import { Icon } from '../components/Icon';
import { useOrders } from '../hooks/useOrders';
import styles from '../styles/Dashboard.module.css';

export function Dashboard() {
  const { orders, loading, retry, cancel, clearPrinted } = useOrders();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = orders.find((o) => o.orderId === selectedId) ?? null;
  const pendingCount = orders.filter(
    (o) => o.printStatus === 'pending' || o.printStatus === 'failed',
  ).length;

  return (
    <div className={styles.content}>
      <section className={styles.queue}>
        <div className={styles.queueHeader}>
          <h2>Active Orders</h2>
          <span className={styles.badge}>{pendingCount} Pending</span>
        </div>

        <div className={styles.list}>
          {loading && <div className={styles.message}>Loading orders…</div>}
          {!loading && orders.length === 0 && (
            <div className={styles.message}>
              <Icon name="printer" size={40} />
              <p>No orders yet</p>
              <small>Orders posted to /api/print-order will appear here.</small>
            </div>
          )}
          {orders.map((order) => (
            <OrderCard
              key={order.orderId}
              order={order}
              selected={order.orderId === selectedId}
              onSelect={setSelectedId}
              onRetry={retry}
              onCancel={cancel}
            />
          ))}
        </div>
      </section>

      <aside className={styles.side}>
        <OrderDetails order={selected} />
        <button className={styles.clearBtn} onClick={clearPrinted}>
          <Icon name="trash" size={16} />
          Clear Printed
        </button>
      </aside>
    </div>
  );
}
