import { useEffect, useState } from 'react';
import type { PrinterInfo } from '@shared/types';
import { Icon } from '../components/Icon';
import styles from '../styles/Settings.module.css';

interface PrinterConfigs {
  [key: string]: string; // e.g., { printer_kitchen: "USB001", printer_cashier: "COM1" }
}


// Fixed printer roles — no add/remove; each always exists as a row, the
// operator just assigns which installed printer it maps to.
//   Cashier -> bill printing (printOrder), bridged into config.cashierPrinter
//   Waiter  -> KOT printing for dine-in orders
//   Kitchen -> KOT printing for pickup/delivery orders (no waiter involved)
const PRINTER_ROLES = ['Cashier', 'Waiter', 'Kitchen'] as const;

function roleKey(role: string): string {
  return `printer_${role.toLowerCase().trim().replace(/\s+/g, '_')}`;
}


export function Settings() {

  const [configs, setConfigs] = useState<PrinterConfigs>({});
    // Separate from `configs` (the SAVED mapping) — this is what the dropdowns
  // actually display and what the user edits. Kept apart so a selection
  // isn't persisted until the operator explicitly clicks Save (see the
  // effect below for why this also needs a stale-printer fallback).
  const [pending, setPending] = useState<PrinterConfigs>({});
  const [staleNotices, setStaleNotices] = useState<Record<string, string>>({});
  const [osPrinters, setOsPrinters] = useState<PrinterInfo[]>([]);

  const [loading, setLoading] = useState(true);
  const [savingRole, setSavingRole] = useState<string | null>(null);
  const [testingRole, setTestingRole] = useState<string | null>(null);

  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  // Runs whenever the saved mapping or the OS printer list changes (initial
  // load, or after loadData() re-runs) — this is what makes "on app start,
  // show the mapped printers" and "if the mapped printer isn't found, fall
  // back to default" both actually work, rather than just trusting whatever
  // string happens to be stored.
  useEffect(() => {
    if (osPrinters.length === 0) return; // don't resolve fallbacks against an empty/not-yet-loaded list

    const nextPending: PrinterConfigs = {};
    const notices: Record<string, string> = {};

    for (const role of PRINTER_ROLES) {
      const key = roleKey(role);
      const saved = configs[key] ?? '';
      const stillInstalled = saved !== '' && osPrinters.some((p) => p.name === saved);

      if (saved && !stillInstalled) {
        // The saved printer is gone (uninstalled, renamed, or this is a
        // different machine than the one that originally configured it).
        // Fall back to the OS's own default printer rather than silently
        // showing a broken/blank selection.
        const fallback = osPrinters.find((p) => p.isDefault)?.name ?? '';
        nextPending[key] = fallback;
        notices[role] = fallback
          ? `Previously mapped to "${saved}", which is no longer installed — defaulted to "${fallback}". Click Save to confirm, or pick a different printer.`
          : `Previously mapped to "${saved}", which is no longer installed, and no default printer was found — please pick one.`;
      } else {
        nextPending[key] = saved;
      }
    }

    setPending(nextPending);
    setStaleNotices(notices);
  }, [configs, osPrinters]);

  async function loadData() {
    try {
      setLoading(true);
      const currentSettings = await window.api.getSettings();
      setConfigs(currentSettings ?? {});

      const list = await window.api.getPrinters();
      setOsPrinters(list ?? []);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to load settings';
      setMessage({ type: 'error', text: errorMsg });
    } finally {
      setLoading(false);
    }
  }

  function flash(type: 'success' | 'error', text: string) {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  }

  function handleDropdownChange(role: string, device: string) {
    setPending({ ...pending, [roleKey(role)]: device });
  }

   async function handleSave(role: string) {
    const key = roleKey(role);
    const device = pending[key] ?? '';
    try {
      setSavingRole(role);
      await window.api.updateSettings(role, device);
      // Repopulate from the save that just succeeded — `configs` becoming
      // the new saved baseline is what makes the mapping correctly persist
      // across a reload/app restart, and what clears the "unsaved" state
      // for this row immediately rather than waiting on a full reload.
      setConfigs((prev) => ({ ...prev, [key]: device }));
      setStaleNotices((prev) => {
        if (!(role in prev)) return prev;
        const next = { ...prev };
        delete next[role];
        return next;
      });
      flash('success', device ? `${role} printer saved: ${device}` : `${role} printer mapping cleared`);
    } catch (err) {
      flash('error', err instanceof Error ? err.message : `Failed to save ${role} printer`);
    } finally {
      setSavingRole(null);
    }
  }

  async function handleTestPrint(role: string) {
    const device = pending[roleKey(role)];
    if (!device) {
      flash('error', `Select a printer for ${role} first`);
      return;
    }
    try {
      setTestingRole(role);
      const result = await window.api.testPrint(device);
      flash('success', result);
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Test print failed');
    } finally {
      setTestingRole(null);
    }
  }

  if (loading) {
    return (
      <div className={styles.settingsPage}>
        <div className={styles.pageHeader}>
          <h1>Settings</h1>
        </div>
        <div className={styles.loading}>Loading settings...</div>
      </div>
    );
  }
  
  return (
     <div className={styles.settingsPage}>
      <div className={styles.pageHeader}>
        <h1>Settings</h1>
      </div>

      <div className={styles.container}>
        {/* Printers */}
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>
            <Icon name="printer" size={20} />
            Printers
          </h2>

          {osPrinters.length === 0 && (
            <small className={styles.hint}>
              No installed printers found. Install the printer in the OS first
              (Windows: Settings → Printers &amp; scanners; macOS: System Settings →
              Printers &amp; Scanners), then reopen this page.
            </small>
          )}

          <div className={styles.printersList}>
            {PRINTER_ROLES.map((role) => {
              const key = roleKey(role);
              const savedDevice = configs[key] ?? '';
              const device = pending[key] ?? '';
              const dirty = device !== savedDevice;
              const busy = savingRole === role || testingRole === role;
              return (
                <div key={role} className={styles.printerCard}>
                  <div className={styles.printerCard}>
                  <div className={styles.printerInfo}>
                    <div className={styles.printerName}>{role}</div>
                  </div>

                  <select
                      className={styles.roleSelect}
                      value={device}
                      onChange={(e) => handleDropdownChange(role, e.target.value)}
                      disabled={busy || osPrinters.length === 0}
                    >
                      <option value="">— Select a printer —</option>
                      {osPrinters.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name}
                          {p.isDefault ? ' (default)' : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      className={styles.saveBtn}
                      onClick={() => handleSave(role)}
                      disabled={busy || !dirty}
                      title={dirty ? 'Save this printer mapping' : 'Already saved'}
                    >
                      <Icon name="check" size={16} />
                      {savingRole === role ? 'Saving...' : 'Save'}
                    </button>

                  <button
                      className={styles.testBtn}
                      onClick={() => handleTestPrint(role)}
                      disabled={busy || !device}
                      title="Send a test slip to this printer"
                    >
                      <Icon name="print" size={16} />
                      {testingRole === role ? 'Testing...' : 'Test'}
                    </button>
                    </div>
                    {staleNotices[role] && (
                    <div className={styles.staleNotice}>
                      <Icon name="alert" size={14} />
                      {staleNotices[role]}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

            {/* About */}
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>
                <Icon name="info" size={20} />
                About
              </h2>

              <div className={styles.aboutContent}>
                <p>
                  <strong>Food Order Printer v1.0</strong>
                </p>
              </div>
            </div>

            {/* Messages */}
            {message && (
              <div className={`${styles.message} ${styles[message.type]}`}>
                {message.type === 'success' ? (
                  <Icon name="check" size={16} />
                ) : (
                  <Icon name="alert" size={16} />
                )}
                {message.text}
              </div>
            )}
          </div>
    </div>
  );
}
