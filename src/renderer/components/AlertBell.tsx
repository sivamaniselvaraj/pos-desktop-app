import { useEffect, useRef, useState } from 'react';
import type { DesktopAlert } from '@shared/alertTypes';
import { Icon } from './Icon';
import { useAlerts } from '../hooks/useAlerts';
import { shortTime } from '../lib/offline';
import styles from '../styles/AlertBell.module.css';

const KIND_LABEL: Record<DesktopAlert['kind'], string> = {
  'new-order': 'New order',
  'kot-failed': 'KOT not printed',
  late: 'Late',
};

/**
 * Header bell (docs/DESKTOP_ALERTS.md): unread count, and a list of the last
 * 50 alerts on this computer. Opening it marks them read; a click on an alert
 * opens the page for it (`onOpen`).
 */
export function AlertBell({ onOpen }: { onOpen: (alert: DesktopAlert | 'settings') => void }) {
  const snap = useAlerts();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const unread = snap?.unread ?? 0;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    setOpen((o) => !o);
    if (!open && unread > 0) void window.api.markAlertsRead().catch(() => undefined);
  };

  const alerts = snap?.alerts ?? [];
  return (
    <div className={styles.wrap} ref={ref}>
      <button
        className={`${styles.bell} ${unread > 0 ? styles.hasUnread : ''}`}
        onClick={toggle}
        title={unread > 0 ? `${unread} new alert${unread === 1 ? '' : 's'}` : 'Alerts'}
        aria-label={unread > 0 ? `Alerts, ${unread} new` : 'Alerts'}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon name="bell" size={16} />
        {unread > 0 && <span className={styles.count}>{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className={styles.panel} role="dialog" aria-label="Alerts">
          <div className={styles.head}>
            <strong>Alerts</strong>
            <div className={styles.headActions}>
              {alerts.some((a) => !a.open) && (
                <button
                  className={styles.link}
                  onClick={() => void window.api.clearAlerts().catch(() => undefined)}
                >
                  Clear
                </button>
              )}
              <button
                className={styles.link}
                onClick={() => {
                  setOpen(false);
                  onOpen('settings');
                }}
              >
                Settings
              </button>
            </div>
          </div>
          {alerts.length === 0 ? (
            <div className={styles.empty}>
              No alerts yet. New phone orders, KOTs that did not print and late orders show here.
            </div>
          ) : (
            <ul className={styles.list}>
              {alerts.map((a) => (
                <li key={a.id}>
                  <button
                    className={styles.item}
                    onClick={() => {
                      setOpen(false);
                      onOpen(a);
                    }}
                  >
                    <span className={`${styles.kind} ${styles[a.kind.replace('-', '')]}`}>
                      {KIND_LABEL[a.kind]}
                    </span>
                    <span className={styles.title}>
                      {a.title}
                      {a.open && <span className={styles.openTag}>Not printed</span>}
                    </span>
                    <span className={styles.message}>{a.message}</span>
                    <span className={styles.time}>{shortTime(a.at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
