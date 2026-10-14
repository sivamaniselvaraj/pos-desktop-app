import { useCallback, useEffect, useState } from 'react';
import { Toast } from '../components/Toast';
import { Icon } from '../components/Icon';
import type { UnprintedKot } from '@shared/types';
import styles from './UnprintedKots.module.css';

const POLL_MS = 10_000;

function waitingLabel(placedAt: string, now: number): string {
  const mins = Math.max(0, Math.round((now - new Date(placedAt).getTime()) / 60000));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

/**
 * Kitchen tickets that have not been printed yet (printer off, no printer set,
 * app was closed). The app also retries these every 30 seconds on its own;
 * this page shows what is waiting and lets staff print a ticket right now.
 */
export function UnprintedKotsPage() {
  const [rows, setRows] = useState<UnprintedKot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const flash = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 4000);
  };

  const load = useCallback(async () => {
    try {
      setRows(await window.api.getUnprintedKots());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load unprinted KOTs');
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function printOne(k: UnprintedKot): Promise<boolean> {
    setBusy((b) => new Set(b).add(k.orderId));
    try {
      await window.api.printKotNow(k.orderId);
      return true;
    } catch (err) {
      flash('error', `Order #${k.orderNumber}: ${err instanceof Error ? err.message : 'Print failed'}`);
      return false;
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(k.orderId);
        return n;
      });
    }
  }

  async function handlePrint(k: UnprintedKot) {
    if (await printOne(k)) flash('success', `KOT printed for order #${k.orderNumber}`);
    await load();
  }

  async function handlePrintAll() {
    let ok = 0;
    for (const k of rows) {
      if (await printOne(k)) ok += 1;
    }
    if (ok > 0) flash('success', `${ok} KOT${ok === 1 ? '' : 's'} printed`);
    await load();
  }

  const anyBusy = busy.size > 0;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h2>Unprinted KOTs</h2>
          <p className={styles.sub}>
            Kitchen tickets that have not reached the printer. The app retries them every 30 seconds;
            print one now if it is urgent.
          </p>
        </div>
        <div className={styles.headActions}>
          <button className={styles.ghost} onClick={() => void load()} disabled={anyBusy}>
            <Icon name="refresh" size={15} />
            Refresh
          </button>
          <button
            className={styles.primary}
            onClick={() => void handlePrintAll()}
            disabled={anyBusy || rows.length === 0}
          >
            <Icon name="print" size={15} />
            Print all ({rows.length})
          </button>
        </div>
      </div>

      <Toast message={message} />
      {error && <p className={styles.error}>{error}</p>}
      {loading && <p className={styles.muted}>Loading…</p>}
      {!loading && !error && rows.length === 0 && (
        <div className={styles.empty}>All KOTs are printed. Nothing is waiting.</div>
      )}

      <div className={styles.list}>
        {rows.map((k) => {
          const isBusy = busy.has(k.orderId);
          const where = k.orderType === 'dine-in' ? `Table ${k.tableNumber ?? '—'}` : 'Takeaway';
          return (
            <div key={k.orderId} className={styles.card}>
              <div className={styles.cardHead}>
                <div>
                  <div className={styles.title}>
                    {where} <span className={styles.orderNo}>· Order #{k.orderNumber}</span>
                  </div>
                  <div className={styles.meta}>
                    Placed {new Date(k.placedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    {' · '}waiting {waitingLabel(k.placedAt, now)}
                    {k.orderSource === 'mobile' ? ` · Mobile${k.deviceName ? ` (${k.deviceName})` : ''}` : ' · POS'}
                    {k.waiterName ? ` · ${k.waiterName}` : ''}
                    {k.customerName ? ` · ${k.customerName}` : ''}
                  </div>
                </div>
                <button
                  className={styles.primary}
                  onClick={() => void handlePrint(k)}
                  disabled={isBusy || anyBusy}
                >
                  <Icon name="print" size={15} />
                  {isBusy ? 'Printing…' : 'Print KOT'}
                </button>
              </div>
              <ul className={styles.items}>
                {k.items.map((i, idx) => (
                  <li key={idx}>
                    <span className={styles.qty}>{i.quantity}×</span>
                    <span>
                      {i.name}
                      {i.note && <em className={styles.note}> — {i.note}</em>}
                    </span>
                  </li>
                ))}
              </ul>
              {k.specialNotes && <div className={styles.orderNote}>Note: {k.specialNotes}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
