import { useState, useEffect } from 'react';
import { useConfirm } from '../context/ConfirmContext';
import { Icon } from '../components/Icon';
import styles from '../styles/Settings.module.css';
import pageStyles from '../styles/Page.module.css';
import { useAuth } from '../context/AuthContext';
import type {
  PairingCode,
  PrinterInfo,
  PrintMethod,
  InvoiceSequenceStatus,
  ApiDevice,
  ServerStatus,
} from '@shared/types';
import { formatDateTime } from '../lib/format';
import { KotWorkflow } from '../components/KotWorkflowSettings';
import { DiscountSettings } from '../components/DiscountSettings';
import { TaxRates } from './TaxRates';
import { AppearanceSettings } from '../components/AppearanceSettings';
import { ReceiptSettings } from '../components/ReceiptSettings';
import { PrinterList } from '../components/PrinterList';

export function Settings() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const canInvoicing = can('invoicing.manage');
  const canDevices = can('users.manage');
  const canKot = can('kot.manage');
  const canDiscounts = can('discount.manage');
  const canTax = can('tax.manage');
  const canBranding = can('branding.manage');
  const canReceipt = can('receipt.manage');
  const [tab, setTab] = useState<'general' | 'kot' | 'discounts' | 'tax' | 'receipt' | 'appearance'>('general');

  const [invoiceStatus, setInvoiceStatus] = useState<InvoiceSequenceStatus | null>(null);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Paired phones (admin only; the main process re-checks the permission).
  const [devices, setDevices] = useState<ApiDevice[]>([]);
  const [pairing, setPairing] = useState(false);
  const [pairCode, setPairCode] = useState<PairingCode | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);

  const [printMethod, setPrintMethodState] = useState<PrintMethod>('direct');
  const [osPrinters, setOsPrinters] = useState<PrinterInfo[]>([]);
  const [loading, setLoading] = useState(true);
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

  async function loadData() {
    try {
      setLoading(true);
      const list = await window.api.getPrinters(true); // fresh list, not the 60 s cache
      setOsPrinters(list ?? []);
      const method = await window.api.getPrintMethod();
      setPrintMethodState(method === 'html' || method === 'image' ? method : 'direct');
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
    if (
      !(await confirm({
        title: 'Revoke device',
        message: `Revoke "${device.name}"? That phone will stop working until it is paired again.`,
        confirmLabel: 'Revoke',
        tone: 'danger',
      }))
    )
      return;
    try {
      await window.api.revokeApiDevice(device.id);
      await loadDevices();
      flash('success', `"${device.name}" was revoked.`);
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Could not revoke the device');
    }
  }

  async function handleResetPin(device: ApiDevice) {
    if (
      !(await confirm({
        title: 'Reset app PIN',
        message: `Reset the app PIN on "${device.name}"? The user sets a new PIN next time they open the app.`,
        confirmLabel: 'Reset PIN',
        tone: 'danger',
      }))
    )
      return;
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
      !(await confirm({
        title: 'Reset invoice sequence',
        message: `Reset the invoice sequence? The next order will be numbered ${nextPreview}. This cannot be undone.`,
        confirmLabel: 'Reset',
        tone: 'danger',
      }))
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

  async function handlePrintMethod(method: PrintMethod) {
    try {
      await window.api.setPrintMethod(method);
      setPrintMethodState(method);
      flash(
        'success',
        method === 'html'
          ? 'Printing bills and KOTs as HTML'
          : method === 'image'
            ? 'Printing bills and KOTs as an image (ESC/POS)'
            : 'Printing bills and KOTs directly (ESC/POS)',
      );
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Could not save print method');
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

      {(canKot || canDiscounts || canTax || canReceipt || canBranding) && (
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
          {canReceipt && (
            <button className={tab === 'receipt' ? styles.tabActive : styles.tab} onClick={() => setTab('receipt')}>
              Receipt
            </button>
          )}
          {canBranding && (
            <button className={tab === 'appearance' ? styles.tabActive : styles.tab} onClick={() => setTab('appearance')}>
              Appearance
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

      {tab === 'receipt' && canReceipt && (
        <div className={styles.container}>
          <ReceiptSettings />
        </div>
      )}

      {tab === 'appearance' && canBranding && (
        <div className={styles.container}>
          <AppearanceSettings />
        </div>
      )}

      <div
        className={styles.container}
        style={
          (tab === 'kot' && canKot) || (tab === 'discounts' && canDiscounts) || (tab === 'tax' && canTax) || (tab === 'receipt' && canReceipt) || (tab === 'appearance' && canBranding)
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
              Printers &amp; Scanners) and reopen this page, or add a network printer by its IP address below.
            </small>
          )}

          <div className={styles.printerCard} style={{ marginBottom: 12 }}>
            <div>
              <div className={styles.printerName}>Print method</div>
              <small className={styles.hint}>
                Direct sends ESC/POS text to the printer. HTML renders the bill and KOT as a page and prints it
                through the printer driver (72 mm, no dialog). Image renders the same page and sends it to the
                printer as dots (any language and ₹, no driver settings involved). Use Test to compare.
              </small>
            </div>
            <select
              className={styles.roleSelect}
              value={printMethod}
              onChange={(e) => handlePrintMethod(e.target.value as PrintMethod)}
            >
              <option value="direct">Direct (ESC/POS)</option>
              <option value="html">HTML (via driver)</option>
              <option value="image">Image (ESC/POS)</option>
            </select>
          </div>

          <PrinterList osPrinters={osPrinters} printMethod={printMethod} flash={flash} />
        </div>

        {/* Invoicing — needs invoicing.manage; real enforcement is server-side by the
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
                  <div>
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
                    <div>
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
