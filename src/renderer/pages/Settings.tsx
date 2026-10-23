import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import styles from '../styles/Settings.module.css';
import pageStyles from '../styles/Page.module.css';
import { useAuth } from '../context/AuthContext';
import type {
  PairingCode,
  PrinterInfo,
  InvoiceSequenceStatus,
  ApiDevice,
  ServerStatus,
} from '../../shared/types';
import { formatDateTime } from '../lib/format';
import { KotWorkflow } from '../components/KotWorkflowSettings';
import { DiscountSettings } from '../components/DiscountSettings';
import { TaxRates } from './TaxRates';

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
  const { can } = useAuth();
  const canInvoicing = can('invoicing.manage');
  const canDevices = can('users.manage');
  const canKot = can('kot.manage');
  const canDiscounts = can('discount.manage');
  const canTax = can('tax.manage');
  const [tab, setTab] = useState<'general' | 'kot' | 'discounts' | 'tax'>('general');

  const [invoiceStatus, setInvoiceStatus] = useState<InvoiceSequenceStatus | null>(null);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Paired phones (admin only; the main process re-checks the permission).
  const [devices, setDevices] = useState<ApiDevice[]>([]);
  const [pairing, setPairing] = useState(false);
  const [pairCode, setPairCode] = useState<PairingCode | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);

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
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null,
  );

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (canInvoicing) loadInvoiceStatus();
    if (canDevices) void loadDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canInvoicing, canDevices]);

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

  async function loadDevices() {
    try {
      setDevices(await window.api.listApiDevices());
      setServerStatus(await window.api.getServerStatus());
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Could not load devices' });
    }
  }

  async function handlePairDevice() {
    setPairing(true);
    try {
      setPairCode(await window.api.createPairingCode());
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Could not create a pairing code');
    } finally {
      setPairing(false);
    }
  }

  async function handleCancelCode() {
    setPairCode(null);
    await window.api.cancelPairingCode().catch(() => undefined);
  }

  // While a code is showing: count down, and watch for the phone pairing.
  useEffect(() => {
    if (!pairCode) return;
    const known = devices.length;
    const tick = setInterval(async () => {
      const left = Math.round((new Date(pairCode.expiresAt).getTime() - Date.now()) / 1000);
      setSecondsLeft(Math.max(0, left));
      if (left <= 0) {
        setPairCode(null);
        return;
      }
      try {
        const list = await window.api.listApiDevices();
        if (list.length > known) {
          setDevices(list);
          setPairCode(null);
          flash('success', 'Phone paired.');
        }
      } catch {
        /* keep showing the code */
      }
    }, 2000);
    setSecondsLeft(Math.max(0, Math.round((new Date(pairCode.expiresAt).getTime() - Date.now()) / 1000)));
    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairCode]);

  async function handleRevokeDevice(device: ApiDevice) {
    if (!window.confirm(`Revoke "${device.name}"? That phone will stop working until it is paired again.`)) return;
    try {
      await window.api.revokeApiDevice(device.id);
      await loadDevices();
      flash('success', `"${device.name}" was revoked.`);
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Could not revoke the device');
    }
  }

  async function handleResetPin(device: ApiDevice) {
    if (!window.confirm(`Reset the app PIN on "${device.name}"? The user sets a new PIN next time they open the app.`)) return;
    try {
      await window.api.resetApiDevicePin(device.id);
      await loadDevices();
      flash('success', `PIN reset on "${device.name}".`);
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Could not reset the PIN');
    }
  }

  function flash(type: 'success' | 'error', text: string) {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  }

  async function loadInvoiceStatus() {
    try {
      setInvoiceLoading(true);
      const status = await window.api.getInvoiceSequenceStatus();
      setInvoiceStatus(status);
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to load invoice sequence status');
    } finally {
      setInvoiceLoading(false);
    }
  }

  async function handleResetInvoiceSequence() {
    const nextPreview = `${new Date().toISOString().slice(0, 10)}-00001`;
    if (
      !confirm(
        `Reset the invoice sequence? The next order will be numbered ${nextPreview}. This cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      setResetting(true);
      await window.api.resetInvoiceSequence();
      await loadInvoiceStatus();
      flash('success', 'Invoice sequence reset');
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to reset invoice sequence');
    } finally {
      setResetting(false);
    }
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
    // Tests whatever's currently shown in the dropdown, even if not yet
    // saved — lets the operator verify before committing to it.
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
    <div className={pageStyles.page}>
      <div className={styles.pageHeader}>
        <h1>Settings</h1>
      </div>

      {(canKot || canDiscounts || canTax) && (
        <div className={styles.tabs}>
          <button className={tab === 'general' ? styles.tabActive : styles.tab} onClick={() => setTab('general')}>
            General
          </button>
          {canKot && (
            <button className={tab === 'kot' ? styles.tabActive : styles.tab} onClick={() => setTab('kot')}>
              KOT workflow
            </button>
          )}
          {canDiscounts && (
            <button className={tab === 'discounts' ? styles.tabActive : styles.tab} onClick={() => setTab('discounts')}>
              Discounts
            </button>
          )}
          {canTax && (
            <button className={tab === 'tax' ? styles.tabActive : styles.tab} onClick={() => setTab('tax')}>
              Tax
            </button>
          )}
        </div>
      )}

      {tab === 'kot' && canKot && (
        <div className={styles.container}>
          <small className={styles.hint}>
            Steps a KOT moves through, and how its card colour changes with waiting time. Applies to this outlet.
          </small>
          <KotWorkflow />
        </div>
      )}

      {tab === 'discounts' && canDiscounts && (
        <div className={styles.container}>
          <small className={styles.hint}>
            The discount percentages staff can choose when giving a discount on an order. Applies to this outlet.
          </small>
          <DiscountSettings />
        </div>
      )}

      {tab === 'tax' && canTax && (
        <div className={styles.container}>
          <TaxRates />
        </div>
      )}

      <div
        className={styles.container}
        style={
          (tab === 'kot' && canKot) || (tab === 'discounts' && canDiscounts) || (tab === 'tax' && canTax)
            ? { display: 'none' }
            : undefined
        }
      >
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
                <div key={role} className={styles.printerCardWrap}>
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

        {/* Invoicing — admin only; real enforcement is server-side by the
            get_invoice_sequence_status()/reset_invoice_sequence() RPCs, this
            just hides the panel for everyone else. */}
        {canInvoicing && (
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>
              <Icon name="print" size={20} />
              Invoicing
            </h2>

            {invoiceLoading ? (
              <small className={styles.hint}>Loading…</small>
            ) : invoiceStatus ? (
              <div className={styles.printerCardWrap}>
                <div className={styles.printerCard}>
                  <div className={styles.printerInfo}>
                    <div className={styles.printerName}>
                      {invoiceStatus.currentSeq} invoice{invoiceStatus.currentSeq === 1 ? '' : 's'}{' '}
                      issued since last reset
                    </div>
                    <small className={styles.hint}>
                      {invoiceStatus.lastResetAt
                        ? `Last reset ${formatDateTime(invoiceStatus.lastResetAt)}${
                            invoiceStatus.resetByName ? ` by ${invoiceStatus.resetByName}` : ''
                          }`
                        : 'Never reset — running since this outlet\'s first invoice'}
                    </small>
                  </div>

                  <button
                    className={styles.saveBtn}
                    onClick={handleResetInvoiceSequence}
                    disabled={resetting}
                    title="Reset the running invoice count back to 00001 — do this monthly, half-yearly or yearly as your accounting needs"
                  >
                    <Icon name="retry" size={16} />
                    {resetting ? 'Resetting…' : 'Reset Sequence'}
                  </button>
                </div>
              </div>
            ) : (
              <small className={styles.hint}>Could not load the invoice sequence.</small>
            )}
          </div>
        )}

        {/* Mobile devices — needs users.manage. Each phone has its own token, shown once. */}
        {canDevices && (
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>
              <Icon name="print" size={20} />
              Mobile devices
            </h2>
            <small className={styles.hint}>
              Only paired phones can place prints or read the menu. On the phone: sign in, enter this server
              address and the 6-digit code shown here. The code works once and expires after 5 minutes. Each phone
              is tied to the user who signed in on it and stops working if that user is deactivated.
              {serverStatus
                ? ` Server address: ${serverStatus.ipAddress || serverStatus.host}:${serverStatus.port}.`
                : ''}
            </small>

            {pairCode ? (
              <div className={styles.tokenBox} role="alert">
                <strong>Pairing code</strong>
                <code style={{ fontSize: 32, letterSpacing: 8, textAlign: 'center' }}>{pairCode.code}</code>
                <small className={styles.hint}>
                  Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}. Waiting for
                  the phone...
                </small>
                <div>
                  <button className={styles.saveBtn} onClick={() => void handleCancelCode()}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className={styles.deviceForm}>
                <button className={styles.saveBtn} onClick={() => void handlePairDevice()} disabled={pairing}>
                  {pairing ? 'Creating code…' : 'Pair a phone'}
                </button>
              </div>
            )}

            <div className={styles.printersList}>
              {devices.length === 0 ? (
                <small className={styles.hint}>No device is paired, so phones cannot reach the API.</small>
              ) : (
                devices.map((d) => (
                  <div key={d.id} className={styles.printerCard}>
                    <div className={styles.printerInfo}>
                      <div className={styles.printerName}>
                        {d.name}
                        {d.userName ? ` (${d.userName})` : ''}
                      </div>
                      {!d.valid && (
                        <small className={styles.hint}>
                          Paired the old way and no longer accepted. Revoke it and pair the phone again.
                        </small>
                      )}
                      <small className={styles.hint}>
                        {d.pinSet ? 'App PIN set' : 'No app PIN yet (the user sets it on the phone)'}
                      </small>
                      <small className={styles.hint}>
                        Paired {formatDateTime(d.createdAt)}
                        {d.lastUsedAt ? `, last used ${formatDateTime(d.lastUsedAt)}` : ', never used'}
                      </small>
                    </div>
                    {d.pinSet && (
                      <button className={styles.cancelBtn} onClick={() => void handleResetPin(d)}>
                        Reset PIN
                      </button>
                    )}
                    <button className={styles.saveBtn} onClick={() => void handleRevokeDevice(d)}>
                      Revoke
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

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
