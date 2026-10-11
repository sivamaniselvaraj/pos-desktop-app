import { useEffect, useMemo, useState } from 'react';
import type { MenuCategory, MenuItemRecord, SaveMenuItemPayload } from '@shared/types';
import styles from '../styles/MenuItemFormModal.module.css';
import { currencySymbol } from '../lib/format';

export interface MenuItemFormModalProps {
  /** Menu cache row being edited; omit to add a new item. */
  item?: MenuItemRecord;
  categories: MenuCategory[];
  /** Persist the item. Throw to show the message in the modal and keep it open; resolve to close it. */
  onSave: (payload: SaveMenuItemPayload) => Promise<void>;
  onClose: () => void;
}

interface TaxOption {
  key: string;
  name: string;
  percent: number;
}
const taxKey = (name: string, percent: number) => `${name}|${percent}`;
const pctText = (n: number) => `${Number.isInteger(n) ? n : Number(n.toFixed(2))}%`;

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
  const itemTaxPercent =
    item?.tax_rate_percent !== null && item?.tax_rate_percent !== undefined && item?.tax_rate_percent !== ''
      ? Number(item.tax_rate_percent)
      : null;
  const [taxChoice, setTaxChoice] = useState(
    itemTaxPercent !== null ? taxKey(str(item?.tax_name) || 'GST', itemTaxPercent) : '',
  );
  // false = price is before tax (the default); true = price already contains the tax.
  const [priceIncludesTax, setPriceIncludesTax] = useState(item?.price_includes_tax === true);
  const [rates, setRates] = useState<TaxOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The taxes on offer are the ones set up on the Tax rates screen, plus "No tax".
  useEffect(() => {
    let alive = true;
    void window.api
      .getTaxRate()
      .then((r) => {
        if (!alive) return;
        const m = new Map<string, TaxOption>();
        const add = (name: string, percent: number) => m.set(taxKey(name, percent), { key: taxKey(name, percent), name, percent });
        if (r.defaultRate.configured) add(r.defaultRate.name, r.defaultRate.ratePercent);
        for (const c of Object.values(r.byCategory)) add(c.name, c.ratePercent);
        setRates([...m.values()].sort((a, b) => a.percent - b.percent || a.name.localeCompare(b.name)));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const taxOptions = useMemo(() => {
    const m = new Map(rates.map((o) => [o.key, o]));
    m.set(taxKey('No tax', 0), { key: taxKey('No tax', 0), name: 'No tax', percent: 0 });
    // Keep the item's current tax selectable even if it is no longer on the Tax rates screen.
    if (itemTaxPercent !== null) {
      const k = taxKey(str(item?.tax_name) || 'GST', itemTaxPercent);
      if (!m.has(k)) m.set(k, { key: k, name: str(item?.tax_name) || 'GST', percent: itemTaxPercent });
    }
    return [...m.values()].sort((a, b) => a.percent - b.percent || a.name.localeCompare(b.name));
  }, [rates, item, itemTaxPercent]);
  const chosenTax = taxOptions.find((o) => o.key === taxChoice) ?? null;

  const preview = useMemo(() => {
    const p = Number(price);
    if (!chosenTax || price.trim() === '' || !Number.isFinite(p) || p < 0) return null;
    const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    if (priceIncludesTax) {
      const tax = r2((p * chosenTax.percent) / (100 + chosenTax.percent));
      return `Price ${p.toFixed(2)} includes ${chosenTax.name} ${pctText(chosenTax.percent)} → customer pays ${p.toFixed(2)} (item ${r2(p - tax).toFixed(2)}, tax ${tax.toFixed(2)})`;
    }
    const tax = r2((p * chosenTax.percent) / 100);
    return `Price ${p.toFixed(2)} + ${chosenTax.name} ${pctText(chosenTax.percent)} → customer pays ${r2(p + tax).toFixed(2)} (item ${p.toFixed(2)}, tax ${tax.toFixed(2)})`;
  }, [chosenTax, price, priceIncludesTax]);

  async function submit() {
    if (saving) return;
    if (!name.trim()) return setError('Name is required');
    if (!categoryId) return setError('Choose a category');
    const priceN = Number(price);
    if (price.trim() === '' || !Number.isFinite(priceN) || priceN < 0) {
      return setError('Price must be 0 or more');
    }
    if (!chosenTax) return setError('Choose a tax for this item');
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
        taxName: chosenTax.name,
        taxPercent: chosenTax.percent,
        priceIncludesTax,
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
            Price ({currencySymbol()}) *
            <input type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>
        </div>

        <div className={styles.taxBox}>
          <label className={styles.formLabel}>
            Tax *
            <select value={taxChoice} onChange={(e) => setTaxChoice(e.target.value)} required>
              <option value="">Select a tax…</option>
              {taxOptions.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.name === 'No tax' ? 'No tax (0%)' : `${o.name} ${pctText(o.percent)}`}
                </option>
              ))}
            </select>
            <small className={styles.hint}>Required. Replaces the category rate for this item. Options come from the Tax rates screen.</small>
          </label>
          <div className={styles.formLabel} role="radiogroup" aria-label="Price and tax">
            Price is *
            <label className={styles.radioRow}>
              <input type="radio" name="priceTax" checked={!priceIncludesTax} onChange={() => setPriceIncludesTax(false)} />
              <span>Exclusive of tax <small className={styles.hint}>– tax is added on top of the price</small></span>
            </label>
            <label className={styles.radioRow}>
              <input type="radio" name="priceTax" checked={priceIncludesTax} onChange={() => setPriceIncludesTax(true)} />
              <span>Inclusive of tax <small className={styles.hint}>– the price already contains the tax</small></span>
            </label>
          </div>
          {preview && <div className={styles.taxPreview}>{preview}</div>}
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
            Cost price ({currencySymbol()})
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
