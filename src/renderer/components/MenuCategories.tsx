import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { Toast } from './Toast';
import type { MenuCategoryAdmin } from '@shared/types';
import styles from '../styles/MenuCategories.module.css';
import modal from '../styles/TableFormModal.module.css';

type Msg = { type: 'success' | 'error'; text: string } | null;

/**
 * Categories tab of the Menu page: add, rename and deactivate this outlet's
 * categories. The database checks menu.categories and keeps names unique per
 * outlet. Deactivating turns the category's items off (reason "Category
 * deactivated"); activating leaves them off, to be switched on from Items.
 */
export function MenuCategories({ canManage, onDirtyChange }: { canManage: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const [rows, setRows] = useState<MenuCategoryAdmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<Msg>(null);
  const [showInactive, setShowInactive] = useState(false);
  // undefined = closed, null = adding, row = renaming
  const [form, setForm] = useState<MenuCategoryAdmin | null | undefined>(undefined);
  const [confirm, setConfirm] = useState<MenuCategoryAdmin | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // The order was changed on screen and not saved yet.
  const [dirty, setDirty] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);

  function flash(type: 'success' | 'error', text: string) {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 4000);
  }

  async function load() {
    try {
      setLoading(true);
      setError(null);
      setRows(await window.api.listMenuCategoriesAdmin());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load categories');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function setActive(row: MenuCategoryAdmin, next: boolean) {
    setBusyId(row.id);
    try {
      const r = await window.api.setMenuCategoryActive(row.id, next);
      flash(
        'success',
        next
          ? `"${row.name}" is active again. Its items are still off: switch them on from Items.`
          : `"${row.name}" deactivated${r.itemsTurnedOff ? `, ${r.itemsTurnedOff} item(s) turned off` : ''}.`,
      );
      setConfirm(null);
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to update the category');
      setConfirm(null);
    } finally {
      setBusyId(null);
    }
  }

  const shown = rows.filter((r) => showInactive || r.isActive);

  // Arrows only rearrange the list on screen. Nothing is saved until "Save order",
  // which sends the whole list in one call, so the numbers never tie.
  function move(row: MenuCategoryAdmin, dir: -1 | 1) {
    const at = shown.findIndex((r) => r.id === row.id);
    const neighbour = shown[at + dir];
    if (!neighbour) return;
    const next = rows.filter((r) => r.id !== row.id);
    next.splice(next.findIndex((r) => r.id === neighbour.id) + (dir === 1 ? 1 : 0), 0, row);
    setRows(next);
    setDirty(true);
  }

  async function saveOrder() {
    setSavingOrder(true);
    try {
      await window.api.reorderMenuCategories(rows.map((r) => r.id));
      setDirty(false);
      flash('success', 'Order saved.');
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to save the order');
    } finally {
      setSavingOrder(false);
    }
  }

  async function discardOrder() {
    setDirty(false);
    await load();
  }

  return (
    <div>
      <div className={styles.bar}>
        <h3>Categories</h3>
        <label className={styles.check}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
        {canManage && (
          <button className={styles.add} onClick={() => setForm(null)} disabled={dirty}>
            <Icon name="plus" size={14} />
            Add category
          </button>
        )}
      </div>
      <p className={styles.hint}>
        Categories belong to this outlet only.{canManage ? ' Deactivating a category turns its items off and hides it when adding items.' : ''}
      </p>
      {dirty && (
        <div className={styles.unsaved}>
          <span>The order has changed and is not saved yet.</span>
          <button className={styles.add} onClick={() => void saveOrder()} disabled={savingOrder}>
            {savingOrder ? 'Saving…' : 'Save order'}
          </button>
          <button className={styles.btn} onClick={() => void discardOrder()} disabled={savingOrder}>
            Discard
          </button>
        </div>
      )}
      <Toast message={message} />
      {error && <p className={styles.error}>{error}</p>}

      {loading ? (
        <p className={styles.hint}>Loading…</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.num}>Order</th>
              <th>Name</th>
              <th className={styles.num}>Items</th>
              <th className={styles.num}>On</th>
              <th>Status</th>
              {canManage && <th className={styles.num}>Sort Order</th> }
              {canManage && <th className={styles.num}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={canManage ? 7 : 5} className={styles.empty}>
                  {rows.length === 0 ? 'No categories yet. Use "Add category".' : 'No active categories.'}
                </td>
              </tr>
            )}
            {shown.map((r) => (
              <tr key={r.id} className={r.isActive ? undefined : styles.inactiveRow}>
                <td className={styles.num}>{dirty ? (rows.findIndex((x) => x.id === r.id) + 1) * 10 : (r.sortOrder ?? '-')}</td>
                <td>{r.name}</td>
                <td className={styles.num}>{r.itemCount}</td>
                <td className={styles.num}>{r.activeItemCount}</td>
                <td>
                  <span className={`${styles.badge} ${r.isActive ? styles.on : styles.off}`}>
                    {r.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
                 {(r.isActive && canManage) && (
                  <td>
                  <div className={styles.actions}>
                    <button
                      className={styles.btn}
                      disabled={savingOrder || shown[0]?.id === r.id}
                      onClick={() => move(r, -1)}
                      aria-label={`Move ${r.name} up`}
                      title="Move up"
                    >
                      ↑
                    </button>
                    <button
                      className={styles.btn}
                      disabled={savingOrder || shown[shown.length - 1]?.id === r.id}
                      onClick={() => move(r, 1)}
                      aria-label={`Move ${r.name} down`}
                      title="Move down"
                    >
                      ↓
                    </button>
                    </div>
                    </td>
                 )}
                {canManage && (
                <td>
                  <div className={styles.actions}>
                    <button className={styles.btn} disabled={busyId === r.id} onClick={() => setForm(r)}>
                      Edit
                    </button>
                    {r.isActive ? (
                      <button
                        className={`${styles.btn} ${styles.danger}`}
                        disabled={busyId === r.id || dirty}
                        onClick={() => (r.activeItemCount > 0 ? setConfirm(r) : void setActive(r, false))}
                      >
                        Deactivate
                      </button>
                    ) : (
                      <button className={styles.btn} disabled={busyId === r.id || dirty} onClick={() => void setActive(r, true)}>
                        Activate
                      </button>
                    )}
                  </div>
                </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {form !== undefined && (
        <CategoryForm
          row={form}
          onClose={() => setForm(undefined)}
          onSaved={async (name) => {
            setForm(undefined);
            flash('success', form ? `Renamed to "${name}".` : `"${name}" added.`);
            await load();
          }}
        />
      )}

      {confirm && (
        <div className={modal.overlay} onClick={() => busyId === null && setConfirm(null)}>
          <div className={modal.modal} onClick={(e) => e.stopPropagation()}>
            <h3>Deactivate &ldquo;{confirm.name}&rdquo;?</h3>
            <p className={styles.warn}>
              {confirm.activeItemCount} item(s) that are on will be turned off with the reason &ldquo;Category deactivated&rdquo;.
              Activating the category later does not turn them back on.
            </p>
            <div className={modal.modalActions}>
              <button type="button" className={modal.cancelBtn} onClick={() => setConfirm(null)} disabled={busyId !== null}>
                Cancel
              </button>
              <button type="button" className={modal.saveBtn} onClick={() => void setActive(confirm, false)} disabled={busyId !== null}>
                {busyId ? 'Deactivating…' : 'Deactivate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CategoryForm({
  row,
  onClose,
  onSaved,
}: {
  row: MenuCategoryAdmin | null;
  onClose: () => void;
  onSaved: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(row?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (saving) return;
    const n = name.trim();
    if (!n) return setError('Category name is required');
    if (n.length > 60) return setError('The name must be 60 characters or fewer');
    setSaving(true);
    setError(null);
    try {
      await window.api.saveMenuCategory({ id: row?.id, name: n });
      await onSaved(n);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
      setSaving(false);
    }
  }

  return (
    <div className={modal.overlay} onClick={() => !saving && onClose()}>
      <form
        className={modal.modal}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h3>{row ? 'Rename category' : 'Add category'}</h3>
        <label className={modal.formLabel}>
          Name
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus placeholder="e.g. Starters" />
        </label>
        {error && <p className={styles.error}>{error}</p>}
        <div className={modal.modalActions}>
          <button type="button" className={modal.cancelBtn} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className={modal.saveBtn} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
