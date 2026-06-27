import { useEffect, useState } from 'react';
import type { OrderWithStatus } from '@shared/types';
import styles from '../styles/Page.module.css';

export function History() {
  const [orders, setOrders] = useState<OrderWithStatus[]>([]);

  useEffect(() => {
    window.api.getOrders().then((all) => setOrders(all.filter((o) => o.printedAt)));
  }, []);

  return (
    <div className={styles.page}>
      <h2>Print History</h2>
      {orders.length === 0 ? (
        <p className={styles.muted}>No printed orders yet.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Order ID</th>
              <th>Customer</th>
              <th>Total</th>
              <th>Status</th>
              <th>Printed</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.orderId}>
                <td>{o.orderId}</td>
                <td>{o.customerName}</td>
                <td>${o.total.toFixed(2)}</td>
                <td>{o.printStatus}</td>
                <td>{o.printedAt ? new Date(o.printedAt).toLocaleString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
