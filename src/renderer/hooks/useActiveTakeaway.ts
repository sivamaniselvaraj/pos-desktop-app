import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActiveTakeawayOrder } from '@shared/types';

// How often the Dashboard re-reads the open takeaway orders (also while the
// Tables tab is shown, so the count on the Takeaway tab stays current).
const REFRESH_MS = 15_000;

/**
 * Open takeaway / pickup / delivery orders for the Dashboard's Takeaway tab
 * (`listActiveTakeaway`, docs/DASHBOARD_TAKEAWAY.md). `enabled` is false for a
 * user without orders.view: nothing is read and the tab is hidden.
 */
export function useActiveTakeaway(enabled: boolean) {
  const [orders, setOrders] = useState<ActiveTakeawayOrder[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const inFlight = useRef(false);

  const reload = useCallback(async () => {
    if (!enabled || inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await window.api.listActiveTakeaway();
      setOrders(result.orders);
      setTruncated(result.truncated);
      setError(null);
      setUpdatedAt(new Date());
    } catch (err) {
      // Keep the last list on screen; only say that it could not be refreshed.
      setError(err instanceof Error ? err.message : 'Failed to load takeaway orders');
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void reload();
    const timer = setInterval(() => {
      if (!document.hidden) void reload();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [enabled, reload]);

  return { orders, truncated, loading, error, updatedAt, reload };
}
