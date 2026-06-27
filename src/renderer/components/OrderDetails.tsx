import { Icon } from './Icon';
import type { OrderWithStatus } from '@shared/types';
import styles from '../styles/Panel.module.css';

interface OrderDetailsProps {
  order: OrderWithStatus | null;
}

export function OrderDetails({ order }: OrderDetailsProps) {
  if (!order) {
    return (
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <Icon name="info" size={18} />
          Order Details
        </div>
        <div className={styles.empty}>Select an order to see details</div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <Icon name="info" size={18} />
        Order Details
      </div>
      <div className={styles.panelBody}>
        <Row label="Order ID" value={order.orderId} />
        <Row label="Customer" value={order.customerName} />
        {order.customerPhone && <Row label="Phone" value={order.customerPhone} />}
        <Row label="Type" value={order.orderType} />
        {order.deliveryAddress && <Row label="Address" value={order.deliveryAddress} />}
        <div className={styles.divider} />
        {order.items.map((item) => (
          <Row
            key={item.id}
            label={`${item.quantity} × ${item.name}`}
            value={`₹${(item.unit_price * item.quantity).toFixed(2)}`}
          />
        ))}
        <div className={styles.divider} />
        <Row label="Subtotal" value={`₹${order.subtotal.toFixed(2)}`} />
        <Row label="Tax" value={`₹${order.tax.toFixed(2)}`} />
        <Row label="Total" value={`₹${order.total.toFixed(2)}`} emphasize />
        {order.specialNotes && (
          <>
            <div className={styles.divider} />
            <div className={styles.notes}>{order.specialNotes}</div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={`${styles.rowValue} ${emphasize ? styles.total : ''}`}>{value}</span>
    </div>
  );
}
