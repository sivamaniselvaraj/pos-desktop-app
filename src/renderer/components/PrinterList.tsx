import { useEffect, useMemo, useState } from 'react';
import { useConfirm } from '../context/ConfirmContext';
import { Icon } from './Icon';
import base from '../styles/Settings.module.css';
import styles from '../styles/PrinterList.module.css';
import type { PrintJobKind, PrinterInfo, PrinterSetup, PrintMethod } from '@shared/types';

const JOBS: { kind: PrintJobKind; label: string }[] = [
  { kind: 'bill', label: 'Bill' },
  { kind: 'kot-dine-in', label: 'Dine-in KOT' },
  { kind: 'kot-takeaway', label: 'Takeaway & delivery KOT' },
];

const ADDRESS_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;

/** A row being edited. `network` decides which of device / address is used when saving. */
interface Row extends PrinterSetup {
  key: string;
  network: boolean;
}

let nextKey = 0;
const toRow = (p: PrinterSetup): Row => ({ ...p, jobs: [...p.jobs], key: `r${nextKey++}`, network: !!p.address });

/** What gets saved for a row: only the device or only the address, as chosen. */
function toSetup(r: Row): PrinterSetup {
  return {
    id: r.id,
    label: r.label.trim(),
    device: r.network ? '' : r.device.trim(),
    address: r.network ? r.address.trim() : '',
    jobs: JOBS.map((j) => j.kind).filter((k) => r.jobs.includes(k)),
  };
}

function rowProblem(r: Row, all: Row[]): string | null {
  const s = toSetup(r);
  if (!s.label) return 'Give the printer a name.';
  if (all.some((o) => o !== r && o.label.trim().toLowerCase() === s.label.toLowerCase()))
    return 'Another printer has this name.';
  if (r.network) {
    if (!s.address) return 'Enter the printer\'s IP address.';
    if (!ADDRESS_RE.test(s.address)) return 'Enter the address like 192.168.1.50 or 192.168.1.50:9100.';
  } else if (!s.device) {
    return 'Choose the installed printer.';
  }
  return null;
}

interface Props {
  osPrinters: PrinterInfo[];
  printMethod: PrintMethod;
  flash: (type: 'success' | 'error', text: string) => void;
}

/**
 * Settings > Printers: any number of printers. Each is an installed printer or a
 * network address, and prints any of: bills, dine-in KOTs, takeaway and delivery
 * KOTs. A job prints on every printer that has it. Saved per machine. See docs/PRINTERS.md.
 */
export function PrinterList({ osPrinters, printMethod, flash }: Props) {
  const confirm = useConfirm();
  const [saved, setSaved] = useState<PrinterSetup[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.api
      .getPrinterSetups()
      .then((list) => {
        if (!alive) return;
        setSaved(list ?? []);
        setRows((list ?? []).map(toRow));
      })
      .catch((err) => flash('error', err instanceof Error ? err.message : 'Could not load the printers'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = useMemo(
    () => JSON.stringify(rows.map(toSetup)) !== JSON.stringify(saved.map((p) => toSetup(toRow(p)))),
    [rows, saved],
  );
  const problems = rows.map((r) => rowProblem(r, rows));
  const missingJobs = JOBS.filter((j) => !rows.some((r) => r.jobs.includes(j.kind)));

  function update(key: string, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function toggleJob(r: Row, kind: PrintJobKind) {
    update(r.key, { jobs: r.jobs.includes(kind) ? r.jobs.filter((j) => j !== kind) : [...r.jobs, kind] });
  }

  function addPrinter() {
    const n = rows.length + 1;
    let label = `Printer ${n}`;
    for (let i = n; rows.some((r) => r.label.toLowerCase() === label.toLowerCase()); i++) label = `Printer ${i + 1}`;
    setRows((rs) => [
      ...rs,
      { key: `r${nextKey++}`, id: '', label, device: '', address: '', jobs: [], network: false },
    ]);
  }

  async function removePrinter(r: Row) {
    if (
      r.id &&
      !(await confirm({
        title: 'Remove printer',
        message: `Remove "${r.label}"? Its jobs stop printing there once you save.`,
        confirmLabel: 'Remove',
        tone: 'danger',
      }))
    )
      return;
    setRows((rs) => rs.filter((x) => x.key !== r.key));
  }

  async function save() {
    const bad = problems.findIndex(Boolean);
    if (bad >= 0) {
      flash('error', `${rows[bad].label || 'A printer'}: ${problems[bad]}`);
      return;
    }
    setSaving(true);
    try {
      const list = await window.api.savePrinterSetups(rows.map(toSetup));
      setSaved(list);
      setRows(list.map(toRow));
      flash('success', `Printers saved (${list.length})`);
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Could not save the printers');
    } finally {
      setSaving(false);
    }
  }

  async function test(r: Row) {
    const problem = rowProblem(r, rows);
    if (problem) {
      flash('error', problem);
      return;
    }
    setTesting(r.key);
    try {
      flash('success', await window.api.testPrinterSetup(toSetup(r)));
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Test print failed');
    } finally {
      setTesting(null);
    }
  }

  if (loading) return <small className={base.hint}>Loading printers…</small>;

  return (
    <div className={styles.list}>
      {rows.length === 0 && (
        <small className={base.hint}>No printers yet. Add one for bills and one for each kitchen or counter.</small>
      )}

      {rows.map((r, i) => {
        const installed = !r.device || osPrinters.some((p) => p.name === r.device);
        return (
          <div key={r.key} className={styles.card}>
            <div className={styles.row}>
              <input
                className={`${base.textInput} ${styles.name}`}
                value={r.label}
                placeholder="Name, e.g. Kitchen 2"
                aria-label="Printer name"
                onChange={(e) => update(r.key, { label: e.target.value })}
              />
              <select
                className={`${base.roleSelect} ${styles.connection}`}
                value={r.network ? 'network' : 'windows'}
                aria-label="How the printer is connected"
                onChange={(e) => update(r.key, { network: e.target.value === 'network' })}
              >
                <option value="windows">Installed printer</option>
                <option value="network">Network (IP address)</option>
              </select>
              {r.network ? (
                <input
                  className={`${base.textInput} ${styles.target}`}
                  value={r.address}
                  placeholder="192.168.1.50"
                  aria-label="IP address"
                  onChange={(e) => update(r.key, { address: e.target.value })}
                />
              ) : (
                <select
                  className={`${base.roleSelect} ${styles.target}`}
                  value={r.device}
                  aria-label="Installed printer"
                  onChange={(e) => update(r.key, { device: e.target.value })}
                >
                  <option value="">— Select a printer —</option>
                  {!installed && <option value={r.device}>{r.device} (not found)</option>}
                  {osPrinters.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className={styles.row}>
              <div className={styles.jobs} role="group" aria-label="What it prints">
                {JOBS.map((j) => (
                  <label key={j.kind} className={styles.job}>
                    <input type="checkbox" checked={r.jobs.includes(j.kind)} onChange={() => toggleJob(r, j.kind)} />
                    {j.label}
                  </label>
                ))}
              </div>
              <div className={styles.actions}>
                <button className={base.testBtn} onClick={() => test(r)} disabled={testing !== null}>
                  <Icon name="print" size={16} />
                  {testing === r.key ? 'Testing...' : 'Test'}
                </button>
                <button className={base.cancelBtn} onClick={() => removePrinter(r)} aria-label={`Remove ${r.label}`}>
                  <Icon name="trash" size={16} />
                </button>
              </div>
            </div>

            {r.network && (
              <small className={base.hint}>
                Prints as an image straight to this address (port 9100 unless you add one, e.g. :9100), whatever the
                print method.
              </small>
            )}
            {!r.network && !installed && (
              <div className={base.staleNotice}>
                <Icon name="alert" size={14} />
                &quot;{r.device}&quot; is not installed on this PC. Choose another printer or enter its IP address.
              </div>
            )}
            {problems[i] && dirty && <small className={styles.problem}>{problems[i]}</small>}
          </div>
        );
      })}

      {missingJobs.length > 0 && rows.length > 0 && (
        <div className={base.staleNotice}>
          <Icon name="alert" size={14} />
          Nothing prints {missingJobs.map((j) => j.label).join(', ')}. Tick it on a printer.
        </div>
      )}

      <div className={styles.footer}>
        <button className={base.testBtn} onClick={addPrinter}>
          <Icon name="plus" size={16} />
          Add printer
        </button>
        <span className={styles.spacer} />
        {dirty && (
          <button className={base.cancelBtn} onClick={() => setRows(saved.map(toRow))} disabled={saving}>
            Undo changes
          </button>
        )}
        <button className={base.saveBtn} onClick={save} disabled={!dirty || saving}>
          <Icon name="check" size={16} />
          {saving ? 'Saving...' : 'Save printers'}
        </button>
      </div>
      <small className={base.hint}>
        Print method {printMethod === 'html' ? 'HTML' : printMethod === 'image' ? 'Image' : 'Direct'} is used for
        installed printers. A job prints on every printer that has it ticked.
      </small>
    </div>
  );
}
