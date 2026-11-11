import { useState } from 'react';
import type { UpdateStatus } from '@shared/types';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { installUpdateWithConfirm } from '../lib/updates';
import styles from '../styles/Page.module.css';

function describe(s: UpdateStatus): string {
  switch (s.phase) {
    case 'disabled':
      return 'Automatic updates are off in this copy (built without an update address, or not installed).';
    case 'checking':
      return 'Checking for a new version…';
    case 'none':
      return 'You have the latest version.';
    case 'downloading':
      return `Downloading version ${s.version ?? ''}… ${s.percent ?? 0}%`;
    case 'ready':
      return `Version ${s.version} is downloaded and ready to install.`;
    case 'error':
      return `Last check failed: ${s.error ?? 'unknown error'}. It tries again automatically.`;
    default:
      return 'The app checks for new versions a minute after it starts and every 4 hours.';
  }
}

export function About({ update }: { update: UpdateStatus | null }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setBusy(true);
    try {
      await window.api.checkForUpdates();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.page}>
      <h2>About</h2>
      <p className={styles.muted}>
        Virunthagam POS - Beta receives order IDs over HTTP from an Android app, fetches the full order
        from database, and prints a receipt to a thermal printer.
      </p>

      <section className={styles.section}>
        <h3>Version and updates</h3>
        <div className={styles.field}>
          <span>Installed version</span>
          <strong>{update?.channel ?? '…'}-{update?.currentVersion ?? '…'}</strong>
        </div>
        {update && (
          <>
            <div className={styles.field}>
              <span>Status</span>
              <span>{describe(update)}</span>
            </div>
            {update.lastCheckedAt && (
              <div className={styles.field}>
                <span>Last checked</span>
                <span>{new Date(update.lastCheckedAt).toLocaleString()}</span>
              </div>
            )}
            {update.releaseNotes && (
              <div style={{ padding: '10px 0', fontSize: 13, whiteSpace: 'pre-wrap' }}>
                <strong>What&apos;s new in {update.version}</strong>
                <div style={{ marginTop: 6 }}>{update.releaseNotes}</div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
              {update.phase !== 'disabled' && update.phase !== 'ready' && (
                <button disabled={busy || update.phase === 'checking' || update.phase === 'downloading'} onClick={() => void check()}>
                  Check for updates
                </button>
              )}
              {update.phase === 'ready' && (
                <button onClick={() => void installUpdateWithConfirm(confirm, update.version)}>
                  Install version {update.version} now
                </button>
              )}
            </div>
            {update.phase !== 'disabled' && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={update.channel === 'beta'}
                  onChange={(e) => void window.api.setUpdateChannel(e.target.checked ? 'beta' : 'stable')}
                />
                Get early (beta) versions on this PC. Use only at the pilot restaurant.
              </label>
            )}
          </>
        )}
      </section>
    </div>
  );
}
