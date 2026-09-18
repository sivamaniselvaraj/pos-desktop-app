import { useEffect, useState } from 'react';
import type { PrinterInfo, ServerStatus } from '@shared/types';
import { Icon } from '../components/Icon';
import styles from '../styles/Settings.module.css';

interface PrinterConfigs {
  [key: string]: string; // e.g., { printer_kitchen: "USB001", printer_cashier: "COM1" }
}

interface PrinterEntry {
  type: string; // Display name: "Kitchen Printer"
  key: string; // Storage key: "printer_kitchen"
  device: string; // Device: "USB001"
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
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [server, setServer] = useState<ServerStatus | null>(null);

  const [configs, setConfigs] = useState<PrinterConfigs>({});
  const [osPrinters, setOsPrinters] = useState<PrinterInfo[]>([]);

  const [loading, setLoading] = useState(true);
  const [savingRole, setSavingRole] = useState<string | null>(null);
  const [testingRole, setTestingRole] = useState<string | null>(null);

  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    loadData();
  }, []);

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

  async function handleSelect(role: string, device: string) {
    const key = roleKey(role);
    try {
      setSavingRole(role);
      await window.api.updateSettings(role, device);
      setConfigs({ ...configs, [key]: device });
      flash('success', device ? `${role} printer set to ${device}` : `${role} printer cleared`);
    } catch (err) {
      flash('error', err instanceof Error ? err.message : `Failed to update ${role} printer`);
    } finally {
      setSavingRole(null);
    }
  }

  async function handleTestPrint(role: string) {
    const device = configs[roleKey(role)];
    console.log("device", role, device)
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
              const device = configs[key] ?? '';
              const busy = savingRole === role || testingRole === role;
              return (
                <div key={role} className={styles.printerCard}>
                  <div className={styles.printerInfo}>
                    <div className={styles.printerName}>{role}</div>
                  </div>

                  <select
                    className={styles.roleSelect}
                    value={device}
                    onChange={(e) => handleSelect(role, e.target.value)}
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
                    className={styles.testBtn}
                    onClick={() => handleTestPrint(role)}
                    disabled={busy || !device}
                    title="Send a test slip to this printer"
                  >
                    <Icon name="print" size={16} />
                    {testingRole === role ? 'Testing...' : 'Test'}
                  </button>
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
