import { useCallback, useEffect, useState } from 'react';
import styles from '../styles/DiscountSettings.module.css';

interface Row {
  key: number;
  percent: string;
  isActive: boolean;
}

let seq = 0;

/** Settings > Discounts: the discount percentages staff may give. The largest active one is the cap. */
export function DiscountSettings() {
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await window.api.getDiscountSettings();
      setRows(s.presets.map((p) => ({ key: ++seq, percent: String(p.percent), isActive: p.isActive })));
      setDirty(false);
      setMsg(null);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not load the discount settings' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const edit = (key: number, patch: Partial<Row>) => {
    setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)));
    setDirty(true);
  };

  const activeMax = Math.max(0, ...rows.filter((r) => r.isActive).map((r) => Number(r.percent) || 0));

  async function save() {
    if (saving) return;
    setMsg(null);
    const presets = rows.map((r) => ({ percent: Number(r.percent), isActive: r.isActive }));
    if (presets.some((p) => r2(p.percent) !== p.percent || !(p.percent > 0 && p.percent < 100))) {
      return setMsg({ ok: false, text: 'Each discount must be above 0 and below 100, with at most two decimals.' });
    }
    if (new Set(presets.map((p) => p.percent)).size !== presets.length) {
      return setMsg({ ok: false, text: 'The same percentage is listed twice.' });
    }
    if (!presets.some((p) => p.isActive)) return setMsg({ ok: false, text: 'At least one discount must stay active.' });
    setSaving(true);
    try {
      await window.api.saveDiscountPresets(presets);
      await load();
      setMsg({ ok: true, text: 'Discounts saved.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not save the discounts' });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p>Loading…</p>;

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.head}>
          <h2>Allowed discounts</h2>
          <button
            className={styles.btn}
            disabled={rows.length >= 10}
            onClick={() => {
              setRows((r) => [...r, { key: ++seq, percent: '', isActive: true }]);
              setDirty(true);
            }}
          >
            Add discount
          </button>
        </div>
        <div className={`${styles.cols} ${styles.grid}`}>
          <span>Discount (%)</span>
          <span>Active</span>
          <span></span>
        </div>
        {rows.map((r) => (
          <div key={r.key} className={`${styles.row} ${styles.grid}`}>
            <input
              className={styles.input}
              type="number"
              min={0}
              max={99.99}
              step="0.01"
              value={r.percent}
              placeholder="e.g. 15"
              onChange={(e) => edit(r.key, { percent: e.target.value })}
            />
            <label className={styles.flag}>
              <input type="checkbox" checked={r.isActive} onChange={(e) => edit(r.key, { isActive: e.target.checked })} /> Yes
            </label>
            <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                className={`${styles.btn} ${styles.danger}`}
                disabled={rows.length <= 1}
                onClick={() => {
                  setRows((x) => x.filter((y) => y.key !== r.key));
                  setDirty(true);
                }}
              >
                Remove
              </button>
            </span>
          </div>
        ))}
        <span className={styles.hint}>
          Staff pick one of the active percentages when giving a discount. The largest active one ({activeMax || '-'}%) is the cap: a
          fixed-amount discount may not be more than that share of the order value. Discounts already given are not changed. Marking an
          order complimentary needs its own permission (orders.complimentary).
        </span>
      </div>

      {msg && <div className={`${styles.msg} ${msg.ok ? styles.ok : styles.err}`}>{msg.text}</div>}
      <div className={styles.footer}>
        <button className={`${styles.btn} ${styles.primary}`} onClick={save} disabled={!dirty || saving}>
          {saving ? 'Saving...' : 'Save discounts'}
        </button>
        {dirty && (
          <button className={styles.btn} onClick={() => void load()} disabled={saving}>
            Discard changes
          </button>
        )}
      </div>
    </div>
  );
}

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
