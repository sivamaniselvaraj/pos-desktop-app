import { useState } from 'react';
import styles from '../styles/MenuOffReason.module.css';

/** The usual reasons, as quick choices. "Other" lets the user type their own. */
export const OFF_REASONS = [
  'Out of stock',
  'Ingredient not available',
  'Equipment problem',
  'Chef not available',
  'Not available today',
  'Seasonal / discontinued',
] as const;
const OTHER = 'Other';
/** What is stored for a typed reason: "Other - <text>" (at most 200 characters in all). */
const OTHER_PREFIX = 'Other - ';
const OTHER_MAX = 200 - OTHER_PREFIX.length;
const withPrefix = (text: string): string => (text.trim() ? `${OTHER_PREFIX}${text.trim()}` : '');

/** Quick choices plus a text box for "Other". Calls onChange with the final reason text ('' while incomplete). */
export function ReasonField({ value, onChange }: { value: string; onChange: (reason: string) => void }) {
  const initialOther = value !== '' && !(OFF_REASONS as readonly string[]).includes(value);
  const [choice, setChoice] = useState<string>(initialOther ? OTHER : value);
  const [custom, setCustom] = useState(initialOther ? value.replace(OTHER_PREFIX, '') : '');

  function pick(c: string) {
    setChoice(c);
    onChange(c === OTHER ? withPrefix(custom) : c);
  }

  return (
    <div className={styles.field}>
      <div className={styles.chips} role="radiogroup" aria-label="Reason">
        {[...OFF_REASONS, OTHER].map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={choice === r}
            className={`${styles.chip} ${choice === r ? styles.chipOn : ''}`}
            onClick={() => pick(r)}
          >
            {r}
          </button>
        ))}
      </div>
      {choice === OTHER && (
        <input
          className={styles.input}
          autoFocus
          maxLength={OTHER_MAX}
          placeholder="Type the reason (saved as “Other - …”)"
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value);
            onChange(withPrefix(e.target.value));
          }}
        />
      )}
    </div>
  );
}

interface Props {
  title: string;
  subtitle?: string;
  busy?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

/** Asks why something is being turned off. The reason is required. */
export function MenuOffReasonModal({ title, subtitle, busy, onConfirm, onCancel }: Props) {
  const [reason, setReason] = useState('');
  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {subtitle && <p className={styles.sub}>{subtitle}</p>}
        <p className={styles.ask}>Why is it being turned off? *</p>
        <ReasonField value={reason} onChange={setReason} />
        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={styles.confirm} disabled={!reason || busy} onClick={() => onConfirm(reason)}>
            {busy ? 'Turning off…' : 'Turn off'}
          </button>
        </div>
      </div>
    </div>
  );
}
