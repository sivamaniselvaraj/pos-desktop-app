import { useState } from 'react';
import { PRESETS, presetRange, type Preset } from '../lib/dateRange';
import styles from '../styles/PeriodPicker.module.css';

export interface Range {
  from: string;
  to: string;
}

/** Today / Yesterday / This month / Last month / Custom range. Calls onChange with the date range (YYYY-MM-DD). */
export function PeriodPicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const [preset, setPreset] = useState<Preset>('today');

  function choose(p: Preset) {
    setPreset(p);
    if (p !== 'custom') onChange(presetRange(p));
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.tabs}>
        {PRESETS.map((p) => (
          <button key={p.key} className={`${styles.tab} ${preset === p.key ? styles.tabOn : ''}`} onClick={() => choose(p.key)}>
            {p.label}
          </button>
        ))}
      </div>
      {preset === 'custom' && (
        <div className={styles.dates}>
          <label>
            From
            <input type="date" value={value.from} max={value.to || undefined} onChange={(e) => onChange({ ...value, from: e.target.value })} />
          </label>
          <label>
            To
            <input type="date" value={value.to} min={value.from || undefined} onChange={(e) => onChange({ ...value, to: e.target.value })} />
          </label>
        </div>
      )}
    </div>
  );
}
