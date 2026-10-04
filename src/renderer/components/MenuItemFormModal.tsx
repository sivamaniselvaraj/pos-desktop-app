import { useState } from 'react';
import type { MenuCategory, MenuItemRecord, SaveMenuItemPayload } from '@shared/types';
import styles from '../styles/MenuItemFormModal.module.css';

export interface MenuItemFormModalProps {
  /** Menu cache row being edited; omit to add a new item. */
  item?: MenuItemRecord;
  categories: MenuCategory[];
  /** Persist the item. Throw to show the message in the modal and keep it open; resolve to close it. */
  onSave: (payload: SaveMenuItemPayload) => Promise<void>;
  onClose: () => void;
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** Parses an optional number field: '' -> null, otherwise Number (NaN is caught by the caller). */
function numOrNull(s: string): number | null {
  return s.trim() === '' ? null : Number(s);
}

/**
 * Add / edit menu item dialog. Validates locally, then hands the payload to
 * onSave; the caller owns the write and the list refresh. The main process
 * validates again, so these checks are for fast feedback only.
 */
export function MenuItemFormModal({ item, categories, onSave, onClose }: MenuItemFormModalProps) {
  const editing = !!item;
  const [name, setName] = useState(str(item?.name));
  const [categoryId, setCategoryId] = useState(str(item?.category_id));
  const [price, setPrice] = useState(str(item?.price));
  const [isVeg, setIsVeg] = useState(item ? item.is_veg !== false : true);
  const [containerCharge, setContainerCharge] = useState(
    editing ? str(item?.container_charge) : '5',
  );
  const [searchKey, setSearchKey] = useState(str(item?.search_key));
  const [description, setDescription] = useState(str(item?.description));
  const [cookingTime, setCookingTime] = useState(str(item?.cooking_time));
  const [sortOrder, setSortOrder] = useState(str(item?.sort_order));
  const [costPrice, setCostPrice] = useState(str(item?.cost_price));
  const [imageUrl, setImageUrl] = useState(str(item?.image_url));
  const [isAvailable, setIsAvailable] = useState(item ? item.is_available !== false : true);
  const [isActive, setIsActive] = useState(item ? item.is_active !== false : true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (saving) return;
    if (!name.trim()) return setError('Name is required');
    if (!categoryId) return setError('Choose a category');
    const priceN = Number(price);
    if (price.trim() === '' || !Number.isFinite(priceN) || priceN < 0) {
      return setError('Price must be 0 or more');
    }
    const cc = numOrNull(containerCharge);
    if (cc !== null && (!Number.isFinite(cc) || cc < 0 || cc > 100)) {
      return setError('Container charge must be a percentage between 0 and 100');
    }
    const cost = numOrNull(costPrice);
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) return setError('Cost price must be 0 or more');
    const cook = numOrNull(cookingTime);
    if (cook !== null && (!Number.isInteger(cook) || cook < 0)) return setError('Cooking time must be whole minutes');
    const sort = numOrNull(sortOrder);
    if (sort !== null && !Number.isInteger(sort)) return setError('Sort order must be a whole number');

    setSaving(true);
    setError(null);
    try {
      await onSave({
        id: item ? str(item.id) : undefined,
        name: name.trim(),
        categoryId,
        price: priceN,
        description,
        isVeg,
        containerCharge: cc,
        costPrice: cost,
        searchKey,
        cookingTime: cook,
        sortOrder: sort,
        imageUrl,
        isAvailable,
        isActive,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
      setSaving(false);
    }
    // On success the parent unmounts this modal.
  }

  return (
    <div className={styles.overlay} onClick={() => !saving && onClose()}>
      <form
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h3>{editing ? 'Edit Menu Item' : 'Add Menu Item'}</h3>

        <label className={styles.formLabel}>
          Name *
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Paneer Tikka" autoFocus />
        </label>

        <div className={styles.row2}>
          <label className={styles.formLabel}>
            Category *
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Select…</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.formLabel}>
            Price (₹) *
            <input type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>
        </div>

        <div className={styles.row2}>
          <div className={styles.formLabel}>
            Type
            <div className={styles.seg} role="radiogroup" aria-label="Veg or non-veg">
              <button type="button" role="radio" aria-checked={isVeg} className={isVeg ? styles.segOn : ''} onClick={() => setIsVeg(true)}>
                <span className={styles.dot} /> Veg
              </button>
              <button type="button" role="radio" aria-checked={!isVeg} className={!isVeg ? styles.segOn : ''} onClick={() => setIsVeg(false)}>
                <span className={`${styles.dot} ${styles.dotNv}`} /> Non-veg
              </button>
            </div>
          </div>
          <label className={styles.formLabel}>
            Container charge (%)
            <input type="number" min={0} max={100} step="0.01" value={containerCharge} onChange={(e) => setContainerCharge(e.target.value)} />
            <small className={styles.hint}>Pickup orders only. Percentage of the line total.</small>
          </label>
        </div>

        <label className={styles.formLabel}>
          Search keywords
          <input value={searchKey} onChange={(e) => setSearchKey(e.target.value)} placeholder="e.g. tandoor spicy starter" />
          <small className={styles.hint}>Staff can find the item by these words as well as its name.</small>
        </label>

        <label className={styles.formLabel}>
          Description
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>

        <div className={styles.row3}>
          <label className={styles.formLabel}>
            Cooking time (min)
            <input type="number" min={0} step={1} value={cookingTime} onChange={(e) => setCookingTime(e.target.value)} />
          </label>
          <label className={styles.formLabel}>
            Sort order
            <input type="number" step={1} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
          </label>
          <label className={styles.formLabel}>
            Cost price (₹)
            <input type="number" min={0} step="0.01" value={costPrice} onChange={(e) => setCostPrice(e.target.value)} />
          </label>
        </div>

        <label className={styles.formLabel}>
          Image URL
          <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…" />
        </label>

        <div className={styles.checks}>
          <label>
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Active <small className={styles.hint}>(off hides it from the menu everywhere)</small>
          </label>
          <label>
            <input type="checkbox" checked={isAvailable} onChange={(e) => setIsAvailable(e.target.checked)} />
            Available <small className={styles.hint}>(off = out of stock right now)</small>
          </label>
        </div>

        {error && <p className={styles.error} role="alert">{error}</p>}

        <div className={styles.modalActions}>
          <button type="button" className={styles.cancelBtn} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className={styles.saveBtn} disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Item'}
          </button>
        </div>
      </form>
    </div>
  );
}
