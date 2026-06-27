import { useCallback, useEffect, useState } from 'react';
import type { OrderWithStatus } from '@shared/types';

export function useOrders() {
  const [orders, setOrders] = useState<OrderWithStatus[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const list = await window.api.getOrders();
    setOrders(list);
  }, []);

  // Insert or update a single order in local state.
  const upsert = useCallback((order: OrderWithStatus) => {
    setOrders((prev) => {
      const without = prev.filter((o) => o.orderId !== order.orderId);
      return [order, ...without].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    });
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));

    const offReceived = window.api.onOrderReceived(upsert);
    const offChanged = window.api.onOrderStatusChanged((order) => {
      // A cancelled order arrives with errorMessage 'Cancelled' — drop it.
      if (order.errorMessage === 'Cancelled') {
        setOrders((prev) => prev.filter((o) => o.orderId !== order.orderId));
      } else {
        upsert(order);
      }
    });

    return () => {
      offReceived();
      offChanged();
    };
  }, [refresh, upsert]);

  const retry = useCallback(async (orderId: string) => {
    await window.api.retryPrint(orderId);
  }, []);

  const cancel = useCallback(async (orderId: string) => {
    await window.api.cancelOrder(orderId);
    setOrders((prev) => prev.filter((o) => o.orderId !== orderId));
  }, []);

  const clearPrinted = useCallback(async () => {
    await window.api.clearPrinted();
    setOrders((prev) => prev.filter((o) => o.printStatus !== 'printed'));
  }, []);

  return { orders, loading, refresh, retry, cancel, clearPrinted };
}
