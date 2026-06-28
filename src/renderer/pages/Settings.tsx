import { useEffect, useState } from 'react';
import type { PrinterInfo, ServerStatus } from '@shared/types';
import { Icon } from '../components/Icon';
import styles from '../styles/Page.module.css';

interface PrinterConfigs {
  [key: string]: string; // e.g., { printer_kitchen: "USB001", printer_cashier: "COM1" }
}

interface PrinterEntry {
  type: string; // Display name: "Kitchen Printer"
  key: string; // Storage key: "printer_kitchen"
  device: string; // Device: "USB001"
}

export function Settings() {
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [server, setServer] = useState<ServerStatus | null>(null);

  const [configs, setConfigs] = useState<PrinterConfigs>({});
  const [printerEntries, setPrinterEntries] = useState<PrinterEntry[]>([]);
  const [maxPrinters, setMaxPrinters] = useState(5);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newPrinterName, setNewPrinterName] = useState('');
  const [newPrinterDevice, setNewPrinterDevice] = useState('');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadData() {
    try {
      setLoading(true);
      window.api.getServerStatus().then(setServer);

      const printerList = await window.api.getPrinters();
      setPrinters(printerList ?? []);

      const currentSettings = await window.api.getSettings();
      setConfigs(currentSettings ?? {});

      const max = await window.api.getMaxPrinters();
      setMaxPrinters(max);

      // Convert to entries format for display
      const entries: PrinterEntry[] = Object.entries(currentSettings ?? {})
        .filter(([key]) => key.startsWith('printer_'))
        .map(([key, device]) => ({
          key,
          type: displayName(key),
          device,
        }));
      setPrinterEntries(entries);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to load settings';
      setMessage({ type: 'error', text: errorMsg });
    } finally {
      setLoading(false);
    }
  }

  function displayName(key: string): string {
    const cleaned = key.replace(/^printer_/, '').replace(/_/g, ' ');
    return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function normalizeKey(name: string): string {
    return `printer_${name.toLowerCase().trim().replace(/\s+/g, '_')}`;
  }

  async function handleAddPrinter() {
    if (!newPrinterName.trim()) {
      setMessage({ type: 'error', text: 'Printer name cannot be empty' });
      return;
    }
    if (!newPrinterDevice) {
      setMessage({ type: 'error', text: 'Please select a device' });
      return;
    }
    if (printerEntries.length >= maxPrinters) {
      setMessage({ type: 'error', text: `Maximum ${maxPrinters} printers allowed` });
      return;
    }

    const key = normalizeKey(newPrinterName);
    if (configs[key]) {
      setMessage({ type: 'error', text: 'This printer name already exists' });
      return;
    }

    try {
      setSaving(true);
      await window.api.updateSettings(newPrinterName, newPrinterDevice);
      setConfigs({ ...configs, [key]: newPrinterDevice });
      setPrinterEntries([
        ...printerEntries,
        { key, type: displayName(key), device: newPrinterDevice },
      ]);
      setNewPrinterName('');
      setNewPrinterDevice('');
      setMessage({ type: 'success', text: `Added ${newPrinterName} printer` });
      setTimeout(() => setMessage(null), 3000);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to add printer';
      setMessage({ type: 'error', text: errorMsg });
    } finally {
      setSaving(false);
    }
  }

  async function handleRemovePrinter(key: string) {
    try {
      setSaving(true);
      await window.api.removePrinter(displayName(key));
      const updated = configs;
      delete updated[key];
      setConfigs(updated);
      setPrinterEntries(printerEntries.filter((e) => e.key !== key));
      setMessage({ type: 'success', text: 'Printer removed' });
      setTimeout(() => setMessage(null), 2000);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to remove printer';
      setMessage({ type: 'error', text: errorMsg });
    } finally {
      setSaving(false);
    }
  }

  async function handleRefreshPrinters() {
    await loadData();
    setMessage({ type: 'success', text: 'Printer list refreshed' });
    setTimeout(() => setMessage(null), 2000);
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

  const canAddMore = printerEntries.length < maxPrinters;

  return (
    <div className={styles.page}>
      <h2>Settings</h2>

      <section className={styles.section}>
        <h3>HTTP Server</h3>
        <p className={styles.muted}>
          The Android app posts order IDs here. Configure the port/host in <code>.env.local</code>.
        </p>
        <div className={styles.field}>
          <span>Host</span>
          <code>{server?.host ?? '—'}</code>
        </div>
        <div className={styles.field}>
          <span>Port</span>
          <code>{server?.port ?? '—'}</code>
        </div>
        <div className={styles.field}>
          <span>Database</span>
          <code>{server?.database ?? '—'}</code>
        </div>
      </section>

      <section className={styles.section}>
        <h3>Available Printers</h3>
        {printers.length === 0 ? (
          <p className={styles.muted}>No printers detected on this machine.</p>
        ) : (
          <ul className={styles.list}>
            {printers.map((p) => (
              <li key={p.name}>
                {p.name} {p.isDefault ? '(default)' : ''}
              </li>
            ))}
          </ul>
        )}
        <p className={styles.muted}>
          Set the default printer name via <code>KITCHEN_PRINTER</code> in <code>.env.local</code>.
        </p>
        <div className={styles.settingsPage}>
          <div className={styles.pageHeader}>
            <h3>Printers</h3>
          </div>

          <div className={styles.container}>
            {/* Configured Printers */}
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>
                <Icon name="printer" size={20} />
                Configured Printers ({printerEntries.length}/{maxPrinters})
              </h2>

              <div className={styles.printersList}>
                {printerEntries.length === 0 ? (
                  <div className={styles.empty}>
                    <p>No printers configured yet. Add one below.</p>
                  </div>
                ) : (
                  printerEntries.map((entry) => (
                    <div key={entry.key} className={styles.printerCard}>
                      <div className={styles.printerInfo}>
                        <div className={styles.printerName}>{entry.type}</div>
                        <div className={styles.printerDevice}>{entry.device}</div>
                      </div>
                      <button
                        className={styles.removeBtn}
                        onClick={() => handleRemovePrinter(entry.key)}
                        disabled={saving}
                        title="Remove this printer"
                      >
                        <Icon name="trash" size={18} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Add New Printer */}
            {canAddMore && (
              <div className={styles.section}>
                <h2 className={styles.sectionTitle}>
                  <Icon name="plus" size={20} />
                  Add New Printer
                </h2>

                <div className={styles.addPrinterForm}>
                  <div className={styles.formGroup}>
                    <label className={styles.label}>Printer Name</label>
                    <input
                      type="text"
                      className={styles.input}
                      placeholder="e.g., Kitchen Printer, Cashier Printer"
                      value={newPrinterName}
                      onChange={(e) => setNewPrinterName(e.target.value)}
                      disabled={saving}
                    />
                    <small className={styles.hint}>
                      Spaces will be converted to underscores when saving
                    </small>
                  </div>

                  <div className={styles.formGroup}>
                    <label className={styles.label}>Select Device</label>
                    {printers.length === 0 ? (
                      <div className={styles.noPrinters}>
                        <p>No system printers found</p>
                        <button
                          className={styles.refreshBtn}
                          onClick={handleRefreshPrinters}
                          disabled={saving}
                        >
                          <Icon name="refresh" size={16} />
                          Refresh
                        </button>
                      </div>
                    ) : (
                      <select
                        className={styles.select}
                        value={newPrinterDevice}
                        onChange={(e) => setNewPrinterDevice(e.target.value)}
                        disabled={saving}
                      >
                        <option value="">-- Select a printer --</option>
                        {printers.map((printer) => (
                          <option key={printer.name} value={printer.name}>
                            {printer.name}
                            {printer.isDefault ? ' (default)' : ''}
                            {!printer.online ? ' (offline)' : ' (online)'}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  <div className={styles.formActions}>
                    <button
                      className={styles.addBtn}
                      onClick={handleAddPrinter}
                      disabled={!newPrinterName.trim() || !newPrinterDevice || saving}
                    >
                      {saving ? 'Adding...' : 'Add Printer'}
                    </button>
                    <button
                      className={styles.refreshBtn}
                      onClick={handleRefreshPrinters}
                      disabled={saving}
                    >
                      <Icon name="refresh" size={16} />
                      Refresh Printers
                    </button>
                  </div>
                </div>
              </div>
            )}

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
                <p>Multi-printer thermal receipt system with ESC/POS support</p>

                <div className={styles.infoBox}>
                  <div className={styles.infoItem}>
                    <strong>Max Printers:</strong> {maxPrinters}
                  </div>
                  <div className={styles.infoItem}>
                    <strong>Configured:</strong> {printerEntries.length}
                  </div>
                  <div className={styles.infoItem}>
                    <strong>Storage:</strong> Database + Local Config
                  </div>
                </div>
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
      </section>
    </div>
  );
}
