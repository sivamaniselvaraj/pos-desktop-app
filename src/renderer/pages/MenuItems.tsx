import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import type { MenuCacheSnapshot, MenuItemRecord } from '@shared/types';
import pageStyles from '../styles/Page.module.css';
import styles from '../styles/MenuItems.module.css';

// Not shown even if present — redundant (every row is this machine's own
// outlet) or just DB bookkeeping rather than something an operator needs to
// see on a menu list. Anything else is rendered, whatever it turns out to
// be called — see MenuItemRecord's comment for why the shape isn't fixed.
const HIDDEN_KEYS = new Set(['outlet_id', 'created_at', 'updated_at']);

// A few keys, if present, are shown first in this order; everything else
// follows alphabetically. Purely cosmetic — works fine if none of these
// exist under these exact names.
const PRIORITY_KEYS = ['id', 'name', 'price', 'category'];

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  return String(value);
}

function columnLabel(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function MenuItemsPage() {
  const [snapshot, setSnapshot] = useState<MenuCacheSnapshot>({
    items: [],
    lastRefreshedAt: null,
    lastError: null,
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null,
  );

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      setLoading(true);
      const result = await window.api.getMenuItems();
      setSnapshot(result);
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to load menu' });
    } finally {
      setLoading(false);
    }
  }

  async function handleRefresh() {
    try {
      setRefreshing(true);
      setMessage(null);
      const result = await window.api.refreshMenuCache();
      setSnapshot(result);
      if (result.lastError) {
        setMessage({ type: 'error', text: result.lastError });
      } else {
        setMessage({ type: 'success', text: `Refreshed — ${result.items.length} item(s)` });
        setTimeout(() => setMessage(null), 3000);
      }
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Refresh failed' });
    } finally {
      setRefreshing(false);
    }
  }

  const columns = useMemo(() => {
    const keys = new Set<string>();
    for (const item of snapshot.items) {
      for (const key of Object.keys(item)) {
        if (!HIDDEN_KEYS.has(key)) keys.add(key);
      }
    }
    const rest = Array.from(keys)
      .filter((k) => !PRIORITY_KEYS.includes(k))
      .sort();
    return [...PRIORITY_KEYS.filter((k) => keys.has(k)), ...rest];
  }, [snapshot.items]);

  return (
    <div className={pageStyles.page}>
      <div className={styles.header}>
        <h2>Menu Items</h2>
        <button className={styles.refreshBtn} onClick={handleRefresh} disabled={refreshing}>
          <Icon name="refresh" size={14} />
          {refreshing ? 'Refreshing…' : 'Refresh from Database'}
        </button>
      </div>

      <p className={pageStyles.muted}>
        {snapshot.lastRefreshedAt
          ? `Last refreshed: ${new Date(snapshot.lastRefreshedAt).toLocaleString('en-IN')}`
          : 'Not yet refreshed.'}
        {' · '}
        Served to Android from this cache — refreshing here is the only way new items or price
        changes reach the app until the next automatic refresh (every 5 minutes).
      </p>

      {message && (
        <p className={message.type === 'error' ? styles.error : styles.success}>{message.text}</p>
      )}
      {!message && snapshot.lastError && <p className={styles.error}>{snapshot.lastError}</p>}

      {loading ? (
        <p className={pageStyles.muted}>Loading…</p>
      ) : snapshot.items.length === 0 ? (
        <p className={pageStyles.muted}>
          No menu items cached yet. Check OUTLET_ID is configured for this machine, then Refresh.
        </p>
      ) : (
        <table className={pageStyles.table}>
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col}>{columnLabel(col)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {snapshot.items.map((item: MenuItemRecord, i) => (
              <tr key={String(item.id ?? i)}>
                {columns.map((col) => (
                  <td key={col}>{formatCell(item[col])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
