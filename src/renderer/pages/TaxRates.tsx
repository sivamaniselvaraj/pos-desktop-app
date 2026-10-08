import { useEffect, useMemo, useState } from 'react';
import { Toast } from '../components/Toast';
import { Icon } from '../components/Icon';
import { formatDateTime } from '../lib/format';
import type { MenuCategory, TaxRateRow } from '@shared/types';
import pageStyles from '../styles/Page.module.css';
import styles from '../styles/UserManagement.module.css';

type Msg = { type: 'success' | 'error'; text: string } | null;

const STATE_LABEL = { current: 'In force', scheduled: 'Scheduled', past: 'Past' } as const;
const STATE_STYLE = {
  current: { background: '#e8f5e9', color: '#2e7d32' },
  scheduled: { background: '#fff3e0', color: '#e65100' },
  past: { background: '#f0f0f0', color: '#777' },
} as const;

/**
 * Tax rates: one default for the outlet plus an optional rate per menu
 * category. Rates are never edited, a new one is added from a date and the
 * old one stays as history, so orders keep the rate they were created under.
 */
export function TaxRates() {
  const [rows, setRows] = useState<TaxRateRow[]>([]);
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<Msg>(null);
  const [showPast, setShowPast] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  function flash(type: 'success' | 'error', text: string) {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 4000);
  }

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const [r, c] = await Promise.all([window.api.listTaxRates(), window.api.listMenuCategories()]);
      setRows(r);
      setCategories(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tax rates');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const catName = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  const scopeName = (id: string | null) => (id === null ? 'Default (all other items)' : (catName.get(id) ?? 'Unknown category'));

  const shown = useMemo(() => {
    const list = rows.filter((r) => showPast || r.state !== 'past');
    return list.sort((a, b) => {
      if ((a.categoryId === null) !== (b.categoryId === null)) return a.categoryId === null ? -1 : 1;
      const n = scopeName(a.categoryId).localeCompare(scopeName(b.categoryId));
      return n || b.effectiveFrom.localeCompare(a.effectiveFrom);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, showPast, catName]);

  const hasDefault = rows.some((r) => r.categoryId === null && r.state === 'current');

  async function handleRemove(r: TaxRateRow) {
    if (!confirm(`Cancel the scheduled rate for ${scopeName(r.categoryId)}?`)) return;
    try {
      setBusyId(r.id);
      await window.api.deleteTaxRate(r.id);
      flash('success', 'Scheduled rate removed');
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to remove the rate');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className={pageStyles.page}>
      <div className={styles.header}>
        <h2>Tax rates</h2>
       
        <div style={{ display: 'inline-flex', gap: 8 }}>
          <button className={styles.addBtn} onClick={load} disabled={loading}>
            <Icon name="refresh" size={14} /> 
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button className={styles.addBtn} onClick={() => setFormOpen(true)}>
            <Icon name="plus" size={14} />
            Set rate
          </button>
        </div>
        </div>
         


      <p className={pageStyles.muted}>
        Prices are tax-exclusive. A category without its own rate uses the default. A new rate applies to orders
        created from its start time; existing orders keep the rate they were created with.
      </p>
      {!loading && !error && !hasDefault && (
        <p className={styles.error}>No default rate is in force: items without a category rate are taxed at 0%.</p>
      )}

      <label style={{ fontSize: 13, display: 'inline-flex', gap: 6, margin: '8px 0' }}>
        <input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} />
        Show past rates
      </label>

      <Toast message={message} />
      {error && <p className={styles.error}>{error}</p>}

      {!error && (
        <table className={pageStyles.table}>
          <thead>
            <tr>
              <th>Applies to</th>
              <th>Tax</th>
              <th>Rate</th>
              <th>From</th>
              <th>Status</th>
              <th>Set by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={7} className={pageStyles.muted}>
                  {loading ? 'Loading…' : 'No tax rates yet. Use "Set rate" to add the default.'}
                </td>
              </tr>
            ) : (
              shown.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{scopeName(r.categoryId)}</strong>
                  </td>
                  <td>{r.taxName}</td>
                  <td>{r.ratePercent === null ? 'Use default' : `${r.ratePercent}%`}</td>
                  <td>{formatDateTime(r.effectiveFrom)}</td>
                  <td>
                    <span className={styles.badge} style={STATE_STYLE[r.state]}>
                      {STATE_LABEL[r.state]}
                    </span>
                  </td>
                  <td>{r.createdByName ?? '—'}</td>
                  <td>
                    {r.state === 'scheduled' && (
                      <button className={styles.cancelBtn} disabled={busyId === r.id} onClick={() => handleRemove(r)}>
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}

      {formOpen && (
        <RateForm
          categories={categories}
          onClose={() => setFormOpen(false)}
          onSaved={async () => {
            setFormOpen(false);
            flash('success', 'Tax rate saved');
            await load();
          }}
        />
      )}
    </div>
  );
}

function RateForm({
  categories,
  onClose,
  onSaved,
}: {
  categories: MenuCategory[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [scope, setScope] = useState('');
  const [name, setName] = useState('GST');
  const [rate, setRate] = useState('');
  const [useDefault, setUseDefault] = useState(false);
  const [schedule, setSchedule] = useState(false);
  const [when, setWhen] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isDefault = scope === '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const value = !isDefault && useDefault ? null : Number(rate);
    if (value !== null && (rate.trim() === '' || !Number.isFinite(value) || value < 0 || value > 100)) {
      setErr('Enter a rate between 0 and 100.');
      return;
    }
    if (schedule && !when) {
      setErr('Choose when the rate starts.');
      return;
    }
    try {
      setSaving(true);
      await window.api.addTaxRate({
        categoryId: isDefault ? null : scope,
        taxName: name,
        ratePercent: value,
        effectiveLocal: schedule ? when : undefined,
      });
      await onSaved();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Failed to save the rate');
      setSaving(false);
    }
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <form className={styles.modal} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Set tax rate</h3>
        <label className={styles.formLabel}>
          Applies to
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">Default (all other items)</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.formLabel}>
          Tax name
          <input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} />
          <span className={styles.hint}>A tax named GST is printed as CGST + SGST halves on the bill.</span>
        </label>
        {!isDefault && (
          <label style={{ fontSize: 13, display: 'flex', gap: 6, marginBottom: 12 }}>
            <input type="checkbox" checked={useDefault} onChange={(e) => setUseDefault(e.target.checked)} />
            Use the default rate for this category
          </label>
        )}
        {(isDefault || !useDefault) && (
          <label className={styles.formLabel}>
            Rate (%)
            <input type="number" step="0.01" min="0" max="100" value={rate} onChange={(e) => setRate(e.target.value)} />
          </label>
        )}
        <label style={{ fontSize: 13, display: 'flex', gap: 6, marginBottom: 12 }}>
          <input type="checkbox" checked={schedule} onChange={(e) => setSchedule(e.target.checked)} />
          Start at a later date and time
        </label>
        {schedule && (
          <label className={styles.formLabel}>
            Starts (outlet time)
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </label>
        )}
        {err && <p className={styles.error}>{err}</p>}
        <div className={styles.modalActions}>
          <button type="button" className={styles.cancelBtn} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className={styles.saveBtn} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
