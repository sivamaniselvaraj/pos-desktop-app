import { useEffect, useState } from 'react';
import type { DiscountOptions, OrderDiscountMode } from '@shared/types';
import { formatMoney } from '../lib/format';
import styles from '../styles/DiscountModal.module.css';

export interface DiscountModalProps {
  /** Heading, for example "Table 4" or "Order 12". */
  title: string;
  /** The orders (rounds) the discount applies to. */
  orderIds: string[];
  /** Discount already on these orders (0 = none). Shows the Remove option when above 0. */
  currentDiscount: number;
  /** Grand total now, for the reader's reference. */
  currentTotal: number;
  currentDiscountPercent: number;
  /** Persist. Throw to show the message in the dialog and keep it open. */
  onApply: (mode: OrderDiscountMode, value: number | undefined, reason: string) => Promise<void>;
  onClose: () => void;
}

/** Discount (percent or fixed amount) or complimentary, with a required reason. */
export function DiscountModal({ title, orderIds, currentDiscount, currentTotal, currentDiscountPercent, onApply, onClose }: DiscountModalProps) {
  const several = orderIds.length > 1;
  const [mode, setMode] = useState<OrderDiscountMode>('percent');
  const [value, setValue] = useState(currentDiscountPercent? String(currentDiscountPercent) : '');
  const [options, setOptions] = useState<DiscountOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  // The allowed percentages and the cap come from the database.
  useEffect(() => {
    let alive = true;
    void window.api
      .getDiscountOptions()
      .then((o) => alive && setOptions(o))
      .catch((e) => alive && setOptionsError(e instanceof Error ? e.message : 'Could not load the discount limits'));
    return () => {
      alive = false;
    };
  }, []);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (saving) return;
    let v: number | undefined;
    if (mode === 'percent' || mode === 'amount') {
      v = Number(value);
      if (value.trim() === '' || !Number.isFinite(v) || v <= 0) {
        return setError(mode === 'percent' ? 'Choose a discount' : 'Enter a discount greater than 0');
      }
    }
    if (mode !== 'none' && !reason.trim()) return setError('A reason is required');
    setSaving(true);
    setError(null);
    try {
      await onApply(mode, v, reason.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the discount');
      setSaving(false);
    }
  }

  const modes: { id: OrderDiscountMode; label: string; hint: string; hidden?: boolean }[] = [
    { id: 'percent', label: 'Percent', hint: '% off the order value before tax' },
    {
      id: 'amount',
      label: 'Fixed amount',
      hint: `amount off, one order only${options ? `, at most ${options.maxPercent}% of the order value` : ''}`,
      hidden: several,
    },
    { id: 'complimentary', label: 'Complimentary', hint: 'customer pays nothing, no tax', hidden: !options?.canComplimentary },
    { id: 'none', label: 'Remove discount', hint: 'Back to the full price', hidden: currentDiscount <= 0 },
  ];

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
        <h3>Discount · {title}</h3>
        <p className={styles.muted}>
          Total now {formatMoney(currentTotal)}
          {currentDiscount > 0 ? ` (includes a discount of ${currentDiscountPercent}% - ${formatMoney(currentDiscount)})` : ''}
          {several ? `. Applies to all ${orderIds.length} orders on this table.` : ''}
        </p>

        <div className={styles.modes} role="radiogroup" aria-label="Discount type">
          {modes
            .filter((m) => !m.hidden)
            .map((m) => (
              <label key={m.id} className={styles.mode}>
                <input type="radio" name="discountMode" checked={mode === m.id} onChange={() => { setMode(m.id); setValue(''); setError(null); }} />
                <span>
                  {m.label} <small>– {m.hint}</small>
                </span>
              </label>
            ))}
        </div>

        {optionsError && <p className={styles.error} role="alert">{optionsError}</p>}

        {mode === 'percent' && (
          <div className={styles.field} role="radiogroup" aria-label="Discount percentage">
            Discount
            <div className={styles.chips}>
              {(options?.percents ?? []).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={Number(value) === p}
                  className={`${styles.chip} ${Number(value) === p ? styles.chipOn : ''}`}
                  onClick={() => { setValue(String(p)); setError(null); }}
                >
                  {p}%
                </button>
              ))}
              {options && options.percents.length === 0 && <small>No discount percentages are set up.</small>}
            </div>
          </div>
        )}

        {mode === 'amount' && (
          <label className={styles.field}>
            Discount amount
            <input
              type="number"
              min={0}
              step="0.01"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
          </label>
        )}

        {mode !== 'none' && (
          <label className={styles.field}>
            Reason (required)
            <input
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
              placeholder={mode === 'complimentary' ? "e.g. Owner's guest" : 'e.g. Regular customer, complaint'}
            />
          </label>
        )}

        <small className={styles.note}>Tax is worked out again on the discounted value. Who gave it, and why, is recorded.</small>

        {error && <p className={styles.error} role="alert">{error}</p>}

        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className={styles.save} disabled={saving}>
            {saving ? 'Saving…' : mode === 'none' ? 'Remove discount' : mode === 'complimentary' ? 'Mark complimentary' : 'Apply discount'}
          </button>
        </div>
      </form>
    </div>
  );
}
