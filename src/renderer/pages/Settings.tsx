import { useEffect, useState } from 'react';
import type { PrinterInfo, ServerStatus } from '@shared/types';
import styles from '../styles/Page.module.css';

export function Settings() {
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [server, setServer] = useState<ServerStatus | null>(null);

  useEffect(() => {
    window.api.getPrinters().then(setPrinters);
    window.api.getServerStatus().then(setServer);
  }, []);

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
      </section>
    </div>
  );
}
