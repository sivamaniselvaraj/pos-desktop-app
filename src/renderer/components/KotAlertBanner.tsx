import { useState } from 'react';
import { Icon } from './Icon';
import { useAlerts } from '../hooks/useAlerts';
import { shortTime } from '../lib/offline';
import styles from '../styles/KotAlertBanner.module.css';

const SHOWN = 3;

/**
 * Red banner under the header while a kitchen ticket has not printed
 * (docs/DESKTOP_ALERTS.md). It goes by itself once the KOT prints (Print
 * again here, the 30 s sweep, the Unprinted KOTs page) or when dismissed.
 * Always mounted, so it is also where alert sounds are played.
 */
export function KotAlertBanner({ onOpenUnprinted }: { onOpenUnprinted?: () => void }) {
  const snap = useAlerts({ sound: true });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ orderId: string; text: string } | null>(null);
  const problems = snap?.problems ?? [];
  if (problems.length === 0) return null;

  const printAgain = async (orderId: string) => {
    setBusy(orderId);
    setError(null);
    try {
      await window.api.printKotNow(orderId); // the banner closes when the print is reported
    } catch (err) {
      setError({
        orderId,
        text:
          err instanceof Error
            ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
            : 'Print failed',
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.banner} role="alert">
      <span className={styles.icon}>
        <Icon name="alert" size={18} />
      </span>
      <div className={styles.body}>
        <strong>
          {problems.length === 1
            ? 'A kitchen ticket did not print.'
            : `${problems.length} kitchen tickets did not print.`}
        </strong>{' '}
        Tell the kitchen, or print again.
        <ul className={styles.list}>
          {problems.slice(0, SHOWN).map((p) => (
            <li key={p.orderId} className={styles.row}>
              <span className={styles.what}>
                <b>{p.title.replace(/ did not print$/, '')}</b> at {shortTime(p.at)}: {p.message}
                {error?.orderId === p.orderId && <span className={styles.err}> {error.text}</span>}
              </span>
              <button
                className={styles.primary}
                disabled={busy !== null}
                onClick={() => void printAgain(p.orderId)}
              >
                {busy === p.orderId ? 'Printing…' : 'Print again'}
              </button>
              <button
                className={styles.secondary}
                onClick={() => void window.api.dismissKotAlert(p.orderId).catch(() => undefined)}
                title="Hide this alert. The ticket stays on the Unprinted KOTs page."
              >
                Dismiss
              </button>
            </li>
          ))}
        </ul>
        {(problems.length > SHOWN || onOpenUnprinted) && (
          <div className={styles.more}>
            {problems.length > SHOWN && <span>and {problems.length - SHOWN} more. </span>}
            {onOpenUnprinted && (
              <button className={styles.link} onClick={onOpenUnprinted}>
                Open Unprinted KOTs
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
