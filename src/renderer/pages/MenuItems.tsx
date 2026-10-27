import { useEffect, useMemo, useRef, useState } from 'react';
import { Toast } from '../components/Toast';
import { Icon } from '../components/Icon';
import { MenuItemFormModal } from '../components/MenuItemFormModal';
import { MenuOffReasonModal } from '../components/MenuOffReason';
import { MenuCategories } from '../components/MenuCategories';
import { useAuth } from '../context/AuthContext';
import type { MenuCacheSnapshot, MenuCategory, MenuItemRecord, SaveMenuItemPayload } from '@shared/types';
import tabStyles from '../styles/MenuCategories.module.css';
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
  'is_active',
  'incentive_type',
  'incentive_value',
  'inactive_reason', // shown under the Off toggle instead
  'inactive_since',
  'inactive_by',
  'inactive_by_name',
  'change_scope',
  'change_batch',
  'sort_order',
  'tax_rate_percent',
  'is_available',
  'category_name',
]);

// A few keys, if present, are shown first in this order; everything else
// follows alphabetically. Purely cosmetic — works fine if none of these
// exist under these exact names.
const PRIORITY_KEYS = ['name', 'price'];

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

/** Menu page: the items list, plus a Categories tab for users who hold menu.categories. */
export function MenuItemsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'items' | 'categories'>('items');
  const [orderUnsaved, setOrderUnsaved] = useState(false);
  // Leaving the Categories tab with an unsaved order would lose it.
  const goTab = (t: 'items' | 'categories') => {
    if (t === tab) return;
    if (orderUnsaved && !window.confirm('The category order is not saved. Leave without saving?')) return;
    setOrderUnsaved(false);
    setTab(t);
  };
  if (!can('menu.categories.view')) return <MenuItemsList />;
  return (
    <div className={pageStyles.page}>
      <div className={tabStyles.tabs}>
        <button className={tab === 'items' ? tabStyles.tabActive : tabStyles.tab} onClick={() => goTab('items')}>
          Items
        </button>
        <button className={tab === 'categories' ? tabStyles.tabActive : tabStyles.tab} onClick={() => goTab('categories')}>
          Categories
        </button>
      </div>
      {tab === 'items' ? <MenuItemsList embedded /> : <MenuCategories canManage={can('menu.categories.manage')} onDirtyChange={setOrderUnsaved} />}
    </div>
  );
}

/** Category filter value for items that have no category. */
const NO_CATEGORY = '__none';

function MenuItemsList({ embedded = false }: { embedded?: boolean }) {
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
  const [statusFilter, setStatusFilter] = useState<'all' | 'on' | 'off'>('all');
  // '' = every category, NO_CATEGORY = items without one, otherwise a category id.
  const [categoryFilter, setCategoryFilter] = useState('');
  // Ticked items (by id) for a bulk on/off.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Turning something off asks for a reason first.
  const [offAsk, setOffAsk] = useState<
    | { kind: 'item'; item: MenuItemRecord }
    | { kind: 'bulk'; ids: string[] }
    | { kind: 'category'; group: { key: string; name: string; items: MenuItemRecord[] } }
    | null
  >(null);
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
    // The list carries only some columns: read the whole row for the form.
    let full = item;
    if (item?.id) {
      try {
        full = await window.api.getMenuItem(String(item.id));
      } catch (e) {
        flash('error', e instanceof Error ? e.message : 'Could not load the item');
        return;
      }
    }
    setFormItem(full);
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
    if (item.is_active !== false) {
      setOffAsk({ kind: 'item', item }); // turning off: ask why first
      return;
    }
    await applyItem(item, true);
  }

  async function applyItem(item: MenuItemRecord, nextActive: boolean, reason?: string) {
    const id = String(item.id ?? '');
    try {
      setTogglingId(id);
      const result = await window.api.setMenuItemActive(id, nextActive, reason);
      setSnapshot(result);
      setOffAsk(null);
      flash('success', `${String(item.name ?? 'Item')} turned ${nextActive ? 'on' : 'off'}`);
    } catch (err) {
      setOffAsk(null);
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to update item' });
    } finally {
      setTogglingId(null);
    }
  }

  async function applyBulk(ids: string[], next: boolean, reason?: string) {
    try {
      setBulkBusy(true);
      const result = await window.api.setMenuItemsActive(ids, next, reason);
      setSnapshot(result);
      setOffAsk(null);
      setSelected(new Set());
      flash('success', `${ids.length} item${ids.length === 1 ? '' : 's'} turned ${next ? 'on' : 'off'}`);
    } catch (err) {
      setOffAsk(null);
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to update the items' });
    } finally {
      setBulkBusy(false);
    }
  }

  async function applyCategory(group: { key: string; name: string; items: MenuItemRecord[] }, next: boolean, reason?: string) {
    try {
      setTogglingCat(group.key);
      const result = await window.api.setCategoryActive(group.key, next, reason);
      setSnapshot(result);
      setOffAsk(null);
      flash('success', `${group.name}: all items turned ${next ? 'on' : 'off'}`);
    } catch (err) {
      setOffAsk(null);
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

  // The category drop-down: the categories that have items, in the categories' order.
  const categoryOptions = useMemo(() => {
    const m = new Map<string, { key: string; name: string; sort: number; count: number }>();
    for (const item of snapshot.items) {
      const key = item.category_id ? String(item.category_id) : NO_CATEGORY;
      const g = m.get(key) ?? {
        key,
        name: key === NO_CATEGORY ? 'No category' : String(item.category_name ?? 'Category'),
        sort: item.category_sort_order == null ? Number.MAX_SAFE_INTEGER : Number(item.category_sort_order),
        count: 0,
      };
      g.count++;
      m.set(key, g);
    }
    return [...m.values()].sort((a, b) =>
      a.key === NO_CATEGORY ? 1 : b.key === NO_CATEGORY ? -1 : a.sort - b.sort || a.name.localeCompare(b.name),
    );
  }, [snapshot.items]);

  // A category that no longer has items (e.g. after a refresh) stops filtering.
  useEffect(() => {
    if (categoryFilter && !categoryOptions.some((c) => c.key === categoryFilter)) setCategoryFilter('');
  }, [categoryOptions, categoryFilter]);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return snapshot.items.filter((item) => {
      if (categoryFilter) {
        const key = item.category_id ? String(item.category_id) : NO_CATEGORY;
        if (key !== categoryFilter) return false;
      }
      return !q ||  String(item.name ?? '').toLowerCase().includes(q) || String(item.search_key ?? '').toLowerCase().includes(q) });
  }, [snapshot.items, searchQuery, categoryFilter]);

  // Items grouped by category (categories A-Z, uncategorised last).
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; name: string; sort: number; items: MenuItemRecord[]; shown: MenuItemRecord[] }>();
    for (const item of filteredItems) {
      const key = item.category_id ? String(item.category_id) : '';
      const sort = item.category_sort_order == null ? Number.MAX_SAFE_INTEGER : Number(item.category_sort_order);
      const g = m.get(key) ?? { key, name: key ? String(item.category_name ?? 'Category') : 'No category', sort, items: [], shown: [] };
      g.items.push(item);
      const on = item.is_active !== false;
      if (statusFilter === 'all' || (statusFilter === 'on' ? on : !on)) g.shown.push(item);
      m.set(key, g);
    }
    return [...m.values()]
      .filter((g) => g.shown.length > 0)
      .sort((a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : a.sort - b.sort || a.name.localeCompare(b.name)));
  }, [filteredItems, statusFilter]);

  const shownIds = useMemo(() => groups.flatMap((g) => g.shown.map((i) => String(i.id ?? ''))).filter(Boolean), [groups]);
  const statusCounts = useMemo(() => {
    const on = filteredItems.filter((i) => i.is_active !== false).length;
    return { all: filteredItems.length, on, off: filteredItems.length - on };
  }, [filteredItems]);
  const itemById = useMemo(() => new Map(snapshot.items.map((i) => [String(i.id ?? ''), i])), [snapshot.items]);

  // Only items you can see stay ticked: a new search or filter drops the rest.
  useEffect(() => {
    setSelected((prev) => {
      const visible = new Set(shownIds);
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [shownIds]);

  const selectedOn = [...selected].filter((id) => itemById.get(id)?.is_active !== false);
  const selectedOff = [...selected].filter((id) => itemById.get(id)?.is_active === false);
  const allShownTicked = shownIds.length > 0 && shownIds.every((id) => selected.has(id));
  const someShownTicked = shownIds.some((id) => selected.has(id));
  const headerBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = someShownTicked && !allShownTicked;
  }, [someShownTicked, allShownTicked]);

  function toggleIds(ids: string[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  return (
    <div className={embedded ? undefined : pageStyles.page}>
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

      <div className={styles.filterRow}>
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Search menu items by name…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <select
          className={styles.categorySelect}
          aria-label="Filter by category"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
        >
          <option value="">All categories ({snapshot.items.length})</option>
          {categoryOptions.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name} ({c.count})
            </option>
          ))}
        </select>
        <div className={styles.seg} role="radiogroup" aria-label="Filter by status">
          {(['all', 'on', 'off'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={statusFilter === s}
              className={statusFilter === s ? styles.segOn : styles.segBtn}
              onClick={() => setStatusFilter(s)}
            >
              {s === 'all' ? 'All' : s === 'on' ? 'On' : 'Off'} ({statusCounts[s]})
            </button>
          ))}
        </div>
      </div>

      {canManage && selected.size > 0 && (
        <div className={styles.bulkBar}>
          <strong>{selected.size} selected</strong>
          <button
            className={styles.bulkOn}
            disabled={bulkBusy || selectedOff.length === 0}
            onClick={() => void applyBulk(selectedOff, true)}
          >
            Turn on ({selectedOff.length})
          </button>
          <button
            className={styles.bulkOff}
            disabled={bulkBusy || selectedOn.length === 0}
            onClick={() => setOffAsk({ kind: 'bulk', ids: selectedOn })}
          >
            Turn off ({selectedOn.length})
          </button>
          <button className={styles.refreshBtn} disabled={bulkBusy} onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}

      <Toast message={message} />
      {!message && snapshot.lastError && <p className={styles.error}>{snapshot.lastError}</p>}

      {loading ? (
        <p className={pageStyles.muted}>Loading…</p>
      ) : snapshot.items.length === 0 ? (
        <p className={pageStyles.muted}>
          No menu items cached yet. Check OUTLET_ID is configured for this machine, then Refresh.
        </p>
      ) : filteredItems.length === 0 ? (
        <p className={pageStyles.muted}>
          No menu items match{searchQuery ? <> &quot;{searchQuery}&quot;</> : ' this category'}.
        </p>
      ) : groups.length === 0 ? (
        <p className={pageStyles.muted}>No {statusFilter === 'on' ? 'items that are on' : 'items that are off'} {searchQuery ? 'match your search' : 'right now'}.</p>
      ) : (
        <table className={pageStyles.table}>
          <thead>
            <tr>
              {canManage && (
                <th style={{ width: 32 }}>
                  <input
                    ref={headerBox}
                    type="checkbox"
                    checked={allShownTicked}
                    onChange={(e) => toggleIds(shownIds, e.target.checked)}
                    aria-label="Select all shown items"
                  />
                </th>
              )}
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
                  <td colSpan={columns.length + 2 + (canManage ? 1 : 0)}>
                    <div className={styles.groupBar}>
                      {canManage && (
                        <input
                          type="checkbox"
                          checked={group.shown.every((i) => selected.has(String(i.id ?? '')))}
                          onChange={(e) => toggleIds(group.shown.map((i) => String(i.id ?? '')), e.target.checked)}
                          aria-label={`Select all in ${group.name}`}
                        />
                      )}
                      <strong>{group.name}</strong>
                      <span className={pageStyles.muted}>
                        {group.items.length} item{group.items.length === 1 ? '' : 's'} · {onCount} on
                      </span>
                      {canManage && (
                        <span className={styles.catActions}>
                          <button
                            className={styles.catOn}
                            onClick={() => void applyCategory(group, true)}
                            disabled={togglingCat === group.key || allOn}
                            title={allOn ? 'Every item in this category is already on' : 'Turn every item in this category on'}
                          >
                            {togglingCat === group.key ? '…' : 'On'}
                          </button>
                          <button
                            className={styles.catOff}
                            onClick={() => setOffAsk({ kind: 'category', group })}
                            disabled={togglingCat === group.key || state === 'Off'}
                            title={state === 'Off' ? 'Every item in this category is already off' : 'Turn every item in this category off'}
                          >
                            Off
                          </button>
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
            {group.shown.map((item: MenuItemRecord, i) => {
              const id = String(item.id ?? i);
              const isActive = item.is_active !== false;
              return (
                <tr key={id} className={isActive ? undefined : styles.inactiveRow}>
                  {canManage && (
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(id)}
                        onChange={(e) => toggleIds([id], e.target.checked)}
                        aria-label={`Select ${String(item.name ?? 'item')}`}
                      />
                    </td>
                  )}
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
                    {!isActive && (
                      <div className={styles.offReason} title={item.inactive_since ? `Turned off ${formatDateTime(String(item.inactive_since))}${item.inactive_by_name ? ` by ${String(item.inactive_by_name)}` : ''}` : undefined}>
                        {item.inactive_reason ? String(item.inactive_reason) : 'No reason recorded'}
                      </div>
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
      {offAsk && (
        <MenuOffReasonModal
          title={
            offAsk.kind === 'item'
              ? `Turn off ${String(offAsk.item.name ?? 'this item')}?`
              : offAsk.kind === 'bulk'
                ? `Turn off ${offAsk.ids.length} item${offAsk.ids.length === 1 ? '' : 's'}?`
                : `Turn off "${offAsk.group.name}"?`
          }
          subtitle={
            offAsk.kind === 'category'
              ? `All ${offAsk.group.items.length} item(s) in this category will be turned off.`
              : offAsk.kind === 'bulk'
                ? 'The same reason is recorded for every selected item.'
                : undefined
          }
          busy={togglingId !== null || togglingCat !== null || bulkBusy}
          onCancel={() => setOffAsk(null)}
          onConfirm={(reason) =>
            offAsk.kind === 'item'
              ? void applyItem(offAsk.item, false, reason)
              : offAsk.kind === 'bulk'
                ? void applyBulk(offAsk.ids, false, reason)
                : void applyCategory(offAsk.group, false, reason)
          }
        />
      )}
    </div>
  );
}
