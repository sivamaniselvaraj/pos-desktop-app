import { Icon, type IconName } from './Icon';
import type { OrderWithStatus, PrintStatus } from '@shared/types';
import styles from '../styles/OrderCard.module.css';

const statusConfig: Record<PrintStatus, { label: string; icon: IconName; cls: string; spin?: boolean }> = {
  pending: { label: 'Pending', icon: 'pending', cls: styles.pending },
  printing: { label: 'Printing', icon: 'spinner', cls: styles.printing, spin: true },
  printed: { label: 'Printed', icon: 'success', cls: styles.printed },
  failed: { label: 'Failed', icon: 'error', cls: styles.failed },
};

interface OrderCardProps {
  order: OrderWithStatus;
  selected: boolean;
  onSelect: (orderId: string) => void;
  onRetry: (orderId: string) => void;
  onCancel: (orderId: string) => void;
}

export function OrderCard({ order, selected, onSelect, onRetry, onCancel }: OrderCardProps) {
  const status = statusConfig[order.printStatus];
  const time = new Date(order.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div
      className={`${styles.card} ${status.cls} ${selected ? styles.selected : ''}`}
      onClick={() => onSelect(order.orderId)}
    >
      <div className={styles.header}>
        <div>
          <div className={styles.orderId}>{order.orderId}</div>
          <div className={styles.time}>
            Order #{order.orderNumber} · {time}
          </div>
        </div>
        <span className={`${styles.badge} ${status.cls}`}>
          <Icon name={status.icon} size={14} className={status.spin ? styles.spin : undefined} />
          {status.label}
        </span>
      </div>

      <div className={styles.details}>
        <div>
          <strong>Customer</strong>
          {order.customerName}
        </div>
        <div>
          <strong>Total</strong>${order.total.toFixed(2)}
        </div>
      </div>

      <div className={styles.items}>
        {order.items.length} item{order.items.length !== 1 ? 's' : ''}
        {order.items.slice(0, 2).map((item) => (
          <div key={item.id} className={styles.itemLine}>
            {item.quantity} × {item.name}
          </div>
        ))}
      </div>

      {order.printStatus === 'failed' && order.errorMessage && (
        <div className={styles.errorMsg}>{order.errorMessage}</div>
      )}

      {(order.printStatus === 'pending' || order.printStatus === 'failed') && (
        <div className={styles.actions}>
          <button
            className={styles.actionBtn}
            onClick={(e) => {
              e.stopPropagation();
              onRetry(order.orderId);
            }}
          >
            <Icon name={order.printStatus === 'failed' ? 'retry' : 'print'} size={14} />
            {order.printStatus === 'failed' ? 'Retry' : 'Print'}
          </button>
          <button
            className={`${styles.actionBtn} ${styles.danger}`}
            onClick={(e) => {
              e.stopPropagation();
              onCancel(order.orderId);
            }}
          >
            <Icon name="cancel" size={14} />
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
