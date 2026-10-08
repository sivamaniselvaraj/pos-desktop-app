import { useEffect, useMemo, useState } from 'react';
import { Toast } from '../components/Toast';
import { Icon } from '../components/Icon';
import { MenuItemFormModal } from '../components/MenuItemFormModal';
import { useAuth } from '../context/AuthContext';
import type { MenuCacheSnapshot, MenuCategory, MenuItemRecord, SaveMenuItemPayload  } from '@shared/types';
import pageStyles from '../styles/Page.module.css';
import styles from '../styles/MenuItems.module.css';
import { formatDateTime } from '../lib/format';

// Not shown even if present — redundant (every row is this machine's own
// outlet) or just DB bookkeeping rather than something an operator needs to
// see on a menu list. Anything else is rendered, whatever it turns out to
// be called — see MenuItemRecord's comment for why the shape isn't fixed.
const HIDDEN_KEYS = new Set([
  'id',
  'outlet_id', 
  'created_at', 
  'updated_at',
  'category_id', 
  'description', 
  'is_veg',
  'cooking_time',
  'container_charge',
  'image_url', 
  'cost_price', 
  'is_active'
]);

// A few keys, if present, are shown first in this order; everything else
// follows alphabetically. Purely cosmetic — works fine if none of these
// exist under these exact names.
const PRIORITY_KEYS = ['name', 'category_name', 'price'];

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
  const { can } = useAuth();
  // Only managers+ add/edit. The database enforces this too (RLS on menu_items).
  const canManage = can('menu.edit');
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  // undefined = closed, null = adding, MenuItemRecord = editing
  const [formItem, setFormItem] = useState<MenuItemRecord | null | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<MenuCacheSnapshot>({
    items: [],
    lastRefreshedAt: null,
    lastError: null,
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [togglingCat, setTogglingCat] = useState<string | null>(null);
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

  async function openForm(item: MenuItemRecord | null) {
    // Categories come from the categories table; if that can't be read, fall
    // back to the ones already present on the cached items.
    let list: MenuCategory[] = [];
    try {
      list = await window.api.listMenuCategories();
    } catch {
      /* fall through to the cache */
    }
    if (list.length === 0) {
      const seen = new Map<string, string>();
      for (const it of snapshot.items) {
        if (it.category_id) seen.set(String(it.category_id), String(it.category_name ?? 'Category'));
      }
      list = [...seen.entries()].map(([id, name]) => ({ id, name }));
    }
    setCategories(list);
    setFormItem(item);
  }

  async function handleSaveItem(payload: SaveMenuItemPayload) {
    const result = await window.api.saveMenuItem(payload); // throws -> shown inside the modal
    setSnapshot(result);
    setFormItem(undefined);
    flash('success', payload.id ? `${payload.name} updated` : `${payload.name} added`);
  }

    async function handleToggleActive(item: MenuItemRecord) {
    const id = String(item.id ?? '');
    if (!id) return;
    const nextActive = !(item.is_active !== false); // treat missing is_active as active
    const nowInactive = !nextActive;
    try {
      setTogglingId(id);
      const result = await window.api.setMenuItemActive(id, nextActive);
      setSnapshot(result);
      flash(
        'success',
        `${String(item.name ?? 'Item')} turned ${nowInactive ? 'off' : 'on'}`,
      );
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to update item' });
    } finally {
      setTogglingId(null);
    }
  }

  async function handleToggleCategory(group: { key: string; name: string; items: MenuItemRecord[] }) {
    const allOn = group.items.every((i) => i.is_active !== false);
    const next = !allOn;
    const verb = next ? 'on' : 'off';
    if (!next && !confirm(`Turn off all ${group.items.length} item(s) in "${group.name}"?`)) return;
    try {
      setTogglingCat(group.key);
      const result = await window.api.setCategoryActive(group.key, next);
      setSnapshot(result);
      flash('success', `${group.name}: all items turned ${verb}`);
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to update category' });
    } finally {
      setTogglingCat(null);
    }
  }

  function flash(type: 'success' | 'error', text: string) {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
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
  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return snapshot.items;
    return snapshot.items.filter((item) => {return String(item.name ?? '').toLowerCase().includes(q) || String(item.search_key ?? '').toLowerCase().includes(q) });
  }, [snapshot.items, searchQuery]);

  // Items grouped by category (categories A-Z, uncategorised last).
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; name: string; items: MenuItemRecord[] }>();
    for (const item of filteredItems) {
      const key = item.category_id ? String(item.category_id) : '';
      const g = m.get(key) ?? { key, name: key ? String(item.category_name ?? 'Category') : 'No category', items: [] };
      g.items.push(item);
      m.set(key, g);
    }
    return [...m.values()].sort((a, b) =>
      a.key === '' ? 1 : b.key === '' ? -1 : a.name.localeCompare(b.name),
    );
  }, [filteredItems]);

  return (
    <div className={pageStyles.page}>
      <div className={styles.header}>
        <h2>Menu Items</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          {canManage && (
            <button className={styles.refreshBtn} onClick={() => void openForm(null)}>
              <Icon name="plus" size={14} />
              Add Item
            </button>
          )}
        <button className={styles.refreshBtn} onClick={handleRefresh} disabled={refreshing}>
          <Icon name="refresh" size={14} />
          {refreshing ? 'Refreshing…' : 'Refresh from Database'}
        </button>
        </div>
      </div>

      <p className={pageStyles.muted}>
        {snapshot.lastRefreshedAt
          ? `Last refreshed: ${formatDateTime(snapshot.lastRefreshedAt)}`
          : 'Not yet refreshed.'}
        {' · '}
        Served to Android from this cache — refreshing here is the only way new items or price
        changes reach the app until the next automatic refresh (every 5 minutes).
      </p>
      <input
        type="text"
        className={styles.searchInput}
        placeholder="Search menu items by name…"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
      />

      <Toast message={message} />
      {!message && snapshot.lastError && <p className={styles.error}>{snapshot.lastError}</p>}

      {loading ? (
        <p className={pageStyles.muted}>Loading…</p>
      ) : snapshot.items.length === 0 ? (
        <p className={pageStyles.muted}>
          No menu items cached yet. Check OUTLET_ID is configured for this machine, then Refresh.
        </p>
         ) : filteredItems.length === 0 ? (
        <p className={pageStyles.muted}>No menu items match &quot;{searchQuery}&quot;.</p>
      ) : (
        <table className={pageStyles.table}>
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col}>{columnLabel(col)}</th>
              ))}
              <th>Status</th>
              {canManage && <th>Actions</th>}
            </tr>
          </thead>
          {groups.map((group) => {
            const onCount = group.items.filter((i) => i.is_active !== false).length;
            const allOn = onCount === group.items.length;
            const state = allOn ? 'On' : onCount === 0 ? 'Off' : 'Mixed';
            return (
              <tbody key={group.key || 'none'}>
                <tr className={styles.groupRow}>
                  <td colSpan={columns.length + 1 + (canManage ? 1 : 0)}>
                    <div className={styles.groupBar}>
                      <strong>{group.name}</strong>
                      <span className={pageStyles.muted}>
                        {group.items.length} item{group.items.length === 1 ? '' : 's'} · {onCount} on
                      </span>
                      {canManage && (
                        <button
                          className={`${styles.statusToggle} ${
                            allOn ? styles.statusOn : state === 'Off' ? styles.statusOff : styles.statusMixed
                          }`}
                          onClick={() => void handleToggleCategory(group)}
                          disabled={togglingCat === group.key}
                          title={allOn ? 'Turn off the whole category' : 'Click to turn the whole category on'}
                        >
                          {togglingCat === group.key ? '…' : (allOn ? 'All on' : state === 'Off' ? 'All off' : 'Some on')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
            {group.items.map((item: MenuItemRecord, i) => {
              const id = String(item.id ?? i);
              const isActive = item.is_active !== false;
              return (
                <tr key={id} className={isActive ? undefined : styles.inactiveRow}>
                  {columns.map((col) => (
                    <td key={col}>{formatCell(item[col])} {col === 'name' ? <span className={`${styles.dot} ${item['is_veg'] ? '' : styles.dotNv}`} /> : ''}</td>
                  ))}
                  <td>
                    {!canManage ? (
                      <span className={`${styles.statusToggle} ${isActive ? styles.statusOn : styles.statusOff}`}>
                        {isActive ? 'On' : 'Off'}
                      </span>
                    ) : (
                    <button
                      className={`${styles.statusToggle} ${isActive ? styles.statusOn : styles.statusOff}`}
                      onClick={() => handleToggleActive(item)}
                      disabled={togglingId === id}
                      title={isActive ? 'Turn off (out of stock)' : 'Turn on (back in stock)'}
                    >
                      {togglingId === id ? '…' : isActive ? 'On' : 'Off'}
                    </button>
                    )}
                  </td>
                  {canManage && (
                    <td>
                      <button
                        className={styles.refreshBtn}
                        onClick={() => void openForm(item)}
                        aria-label={`Edit ${String(item.name ?? 'item')}`}
                      >
                        <Icon name="edit" size={14} />
                        Edit
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
            );
          })}
        </table>
      )}
      {formItem !== undefined && (
        <MenuItemFormModal
          item={formItem ?? undefined}
          categories={categories}
          onSave={handleSaveItem}
          onClose={() => setFormItem(undefined)}
        />
      )}
    </div>
  );
}
