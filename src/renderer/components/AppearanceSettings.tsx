import { useMemo, useState, type CSSProperties } from 'react';
import { useAuth } from '../context/AuthContext';
import { applyBrand, BRAND_PRESETS, brandProblem, DEFAULT_BRAND, deriveBrand, isValidBrand } from '../lib/brand';
import styles from '../styles/AppearanceSettings.module.css';

/** Settings > Appearance: the app colour of the whole business. Needs branding.manage. */
export function AppearanceSettings() {
  const { access } = useAuth();
  const saved = (access?.org?.brandColor ?? DEFAULT_BRAND).toLowerCase();
  const [current, setCurrent] = useState(saved); // what the app uses now
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const problem = brandProblem(draft);
  const valid = isValidBrand(draft) && !problem;
  const dirty = draft.trim().toLowerCase() !== current;
  const preview = useMemo(() => {
    if (!valid) return null;
    const t = deriveBrand(draft.trim());
    return {
      '--brand': t.brand,
      '--brand-dark': t.dark,
      '--brand-soft': t.soft,
      '--brand-softer': t.softer,
      '--brand-text': t.text,
      '--on-brand': t.onBrand,
    } as CSSProperties;
  }, [draft, valid]);

  async function save(color: string | null) {
    setBusy(true);
    setMessage(null);
    try {
      const done = await window.api.saveBrandColor(color);
      const next = (done ?? DEFAULT_BRAND).toLowerCase();
      applyBrand(done);
      setCurrent(next);
      setDraft(next);
      setMessage({ ok: true, text: color ? 'Colour saved. Other devices pick it up the next time they sign in.' : 'Back to the default colour.' });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : 'Could not save the colour' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <h3>App colour</h3>
      <p className={styles.muted}>
        The colour of buttons, the menu and highlights for the whole business. Status colours (completed, cancelled, table states)
        and the colours of the kitchen steps stay as they are.
      </p>

      <div className={styles.swatches} role="radiogroup" aria-label="Preset colours">
        {BRAND_PRESETS.map((p) => (
          <button
            key={p.hex}
            type="button"
            role="radio"
            aria-checked={draft.trim().toLowerCase() === p.hex}
            aria-label={p.name}
            title={p.name}
            className={`${styles.swatch} ${draft.trim().toLowerCase() === p.hex ? styles.swatchOn : ''}`}
            style={{ background: p.hex }}
            onClick={() => setDraft(p.hex)}
          />
        ))}
      </div>

      <div className={styles.custom}>
        <label>
          Pick any colour
          <input
            type="color"
            value={isValidBrand(draft) ? draft.trim() : DEFAULT_BRAND}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Colour picker"
          />
        </label>
        <label>
          Or type it
          <input
            className={styles.hex}
            value={draft}
            maxLength={7}
            onChange={(e) => setDraft(e.target.value.startsWith('#') || e.target.value === '' ? e.target.value : `#${e.target.value}`)}
            placeholder="#4caf50"
            aria-label="Colour code"
          />
        </label>
      </div>

      {problem && draft.trim() !== '' && <p className={styles.error} role="alert">{problem}</p>}

      <div className={styles.preview} style={preview ?? undefined} aria-label="Preview">
        <span className={styles.previewTitle}>Preview</span>
        <button type="button" className={styles.pvBtn} tabIndex={-1}>Place Order</button>
        <span className={styles.pvChip}>Selected</span>
        <span className={styles.pvLink}>Invoice link</span>
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.save} disabled={busy || !valid || !dirty} onClick={() => void save(draft.trim().toLowerCase())}>
          {busy ? 'Saving…' : 'Save colour'}
        </button>
        <button type="button" className={styles.reset} disabled={busy || current === DEFAULT_BRAND} onClick={() => void save(null)}>
          Reset to default
        </button>
      </div>
      {message && (
        <p className={message.ok ? styles.ok : styles.error} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}
