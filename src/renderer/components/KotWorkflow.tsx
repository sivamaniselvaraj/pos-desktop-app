import { useEffect, useState } from 'react';
import { KOT_STATUS_CODES } from '../../shared/types';
import type { KotTimeLevel, KotWorkflow as Workflow } from '@shared/types';
import styles from '../styles/KotWorkflow.module.css';

interface Row {
  key: string;
  id?: string;
  code: string;
  name: string;
  color: string;
  actionLabel: string;
  showOnBoard: boolean;
  backKeys: string[];
  kotCount: number;
}

let seq = 0;
const newKey = () => `n${++seq}`;

function toRows(w: Workflow): Row[] {
  const keys = w.steps.map((s) => s.id ?? newKey());
  return w.steps.map((s, i) => ({
    key: keys[i],
    id: s.id,
    code: s.code,
    name: s.name,
    color: s.color,
    actionLabel: s.actionLabel,
    showOnBoard: s.showOnBoard,
    backKeys: s.backTo.map((p) => keys[p - 1]).filter(Boolean),
    kotCount: s.kotCount ?? 0,
  }));
}

/**
 * KOT workflow editor: the steps a KOT moves through and the waiting-time
 * colours. Reusable (the Settings page embeds it). Rules are enforced by the
 * database when saving; the first step is where KOTs start, the last is final
 * (leaves the board), forward always goes to the next step.
 */
export function KotWorkflow() {
  const [rows, setRows] = useState<Row[]>([]);
  const [levels, setLevels] = useState<KotTimeLevel[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    try {
      setLoading(true);
      const w = await window.api.getKotWorkflow();
      setRows(toRows(w));
      setLevels(w.levels);
      setDirty(false);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed to load the workflow' });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  function editRow(i: number, patch: Partial<Row>) {
    setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    setDirty(true);
  }
  function move(i: number, d: -1 | 1) {
    setRows((r) => {
      const next = [...r];
      [next[i], next[i + d]] = [next[i + d], next[i]];
      return next;
    });
    setDirty(true);
  }
  function addStep() {
    // New steps go before the final step.
    setRows((r) => {
      const next = [...r];
      next.splice(Math.max(next.length - 1, 0), 0, {
        key: newKey(), code: KOT_STATUS_CODES.find((c) => !next.some((r) => r.code === c)) ?? '', name: '', color: '#2980b9', actionLabel: '', showOnBoard: true, backKeys: [], kotCount: 0,
      });
      return next;
    });
    setDirty(true);
  }
  function removeStep(i: number) {
    const key = rows[i].key;
    setRows((r) => r.filter((_, j) => j !== i).map((x) => ({ ...x, backKeys: x.backKeys.filter((k) => k !== key) })));
    setDirty(true);
  }
  function toggleBack(i: number, key: string) {
    const has = rows[i].backKeys.includes(key);
    editRow(i, { backKeys: has ? rows[i].backKeys.filter((k) => k !== key) : [...rows[i].backKeys, key] });
  }
  function editLevel(i: number, patch: Partial<KotTimeLevel>) {
    setLevels((l) => l.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const pos = new Map(rows.map((r, i) => [r.key, i + 1]));
      await window.api.saveKotWorkflow({
        steps: rows.map((r, i) => ({
          id: r.id,
          code: r.code,
          name: r.name.trim(),
          color: r.color,
          actionLabel: r.actionLabel.trim(),
          showOnBoard: r.showOnBoard,
          backTo: r.backKeys.map((k) => pos.get(k) ?? 0).filter((p) => p > 0 && p < i + 1).sort((a, b) => a - b),
        })),
        levels: levels.map((l) => ({ ...l, name: l.name.trim(), fromMinutes: Number(l.fromMinutes) || 0 })),
      });
      setMsg({ ok: true, text: 'Workflow saved.' });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not save the workflow' });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className={styles.hint}>Loading workflow...</div>;

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.head}>
          <h2>Steps</h2>
          <button className={`${styles.btn} ${styles.primary}`} onClick={addStep} disabled={rows.length >= KOT_STATUS_CODES.length}>
            Add step
          </button>
        </div>
        <div className={`${styles.cols} ${styles.steps}`}>
          <span>Order</span><span>Step name</span><span>Colour</span><span>Button to enter this step</span>
          <span>Can go back to</span><span>On board</span><span></span>
        </div>
        {rows.map((r, i) => {
          const first = i === 0;
          const last = i === rows.length - 1;
          return (
            <div key={r.key} className={`${styles.row} ${styles.steps}`}>
              <span className={styles.pos}>
                {i + 1}
                <span style={{ display: 'flex', flexDirection: 'column', marginLeft: 4 }}>
                  <button className={styles.mini} disabled={i <= 1 || last} onClick={() => move(i, -1)} aria-label="Move up">▲</button>
                  <button className={styles.mini} disabled={i >= rows.length - 2} onClick={() => move(i, 1)} aria-label="Move down">▼</button>
                </span>
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <input className={styles.input} value={r.name} maxLength={30} placeholder="Step name"
                       onChange={(e) => editRow(i, { name: e.target.value })} />
                {r.id ? (
                  <span className={styles.hint}>Status value: {r.code}</span>
                ) : (
                  <select className={styles.input} value={r.code} onChange={(e) => editRow(i, { code: e.target.value })}>
                    {KOT_STATUS_CODES.filter((c) => c === r.code || !rows.some((x) => x.code === c)).map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                )}
              </div>
              <input type="color" className={styles.color} value={r.color} onChange={(e) => editRow(i, { color: e.target.value })} />
              {first ? (
                <span className={styles.flag}>Starts here</span>
              ) : (
                <input className={styles.input} value={r.actionLabel} maxLength={30} placeholder="e.g. Mark ready"
                       onChange={(e) => editRow(i, { actionLabel: e.target.value })} />
              )}
              <div className={styles.back}>
                {first && <span className={styles.flag}>None</span>}
                {rows.slice(0, i).map((p) => (
                  <label key={p.key}>
                    <input type="checkbox" checked={r.backKeys.includes(p.key)} onChange={() => toggleBack(i, p.key)} />
                    {p.name || 'Unnamed'}
                  </label>
                ))}
              </div>
              <span className={styles.flag}>
                {last ? (
                  'Final step (leaves board)'
                ) : (
                  <label><input type="checkbox" checked={r.showOnBoard} onChange={(e) => editRow(i, { showOnBoard: e.target.checked })} /> Yes</label>
                )}
              </span>
              <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button className={`${styles.btn} ${styles.danger}`} onClick={() => removeStep(i)}
                        disabled={first || last || r.kotCount > 0}
                        title={r.kotCount > 0 ? `${r.kotCount} KOT(s) are in this step` : first || last ? 'The first and last steps stay' : 'Remove step'}>
                  Remove
                </button>
              </span>
            </div>
          );
        })}
        <span className={styles.hint}>
          The first step (New) and the last step (Served) are fixed: every new item starts at New, and Served takes the card off the board. The last step is final and takes the card off the board.
          Each step uses one of the six status values (new, cancelled, confirmed, preparing, ready, served), so at most six steps. Forward always goes to the next step; going back is only possible to the steps ticked in &ldquo;Can go back to&rdquo;.
          A step that still holds KOTs cannot be removed.
        </span>
      </div>

      <div className={styles.card}>
        <div className={styles.head}>
          <h2>Waiting-time colours</h2>
          <button className={styles.btn} onClick={() => { setLevels((l) => [...l, { name: '', fromMinutes: (l[l.length - 1]?.fromMinutes ?? 0) + 10, color: '#c0392b' }]); setDirty(true); }}>
            Add level
          </button>
        </div>
        <div className={`${styles.cols} ${styles.levelsGrid}`}>
          <span>Level</span><span>Starts after (minutes)</span><span>Colour</span><span></span>
        </div>
        {levels.map((l, i) => (
          <div key={i} className={`${styles.row} ${styles.levelsGrid}`}>
            <input className={styles.input} value={l.name} maxLength={30} placeholder="Level name" onChange={(e) => editLevel(i, { name: e.target.value })} />
            <input className={styles.input} type="number" min={0} value={i === 0 ? 0 : l.fromMinutes} disabled={i === 0}
                   onChange={(e) => editLevel(i, { fromMinutes: Number(e.target.value) })} />
            <input type="color" className={styles.color} value={l.color} onChange={(e) => editLevel(i, { color: e.target.value })} />
            <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className={`${styles.btn} ${styles.danger}`} disabled={i === 0 || levels.length <= 1}
                      onClick={() => { setLevels((x) => x.filter((_, j) => j !== i)); setDirty(true); }}>Remove</button>
            </span>
          </div>
        ))}
        <span className={styles.hint}>
          A card uses the colour of the highest level whose start time it has passed. Waiting time counts from when the KOT was created. The first level starts at 0.
        </span>
      </div>

      {msg && <div className={`${styles.msg} ${msg.ok ? styles.ok : styles.err}`}>{msg.text}</div>}
      <div className={styles.footer}>
        <button className={`${styles.btn} ${styles.primary}`} onClick={save} disabled={!dirty || saving}>
          {saving ? 'Saving...' : 'Save workflow'}
        </button>
        {dirty && <button className={styles.btn} onClick={() => void load()} disabled={saving}>Discard changes</button>}
      </div>
    </div>
  );
}
