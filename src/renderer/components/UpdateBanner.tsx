import { useState } from 'react';
import type { UpdateStatus } from '@shared/types';
import { useConfirm } from '../context/ConfirmContext';
import { installUpdateWithConfirm } from '../lib/updates';
import styles from '../styles/UpdateBanner.module.css';

/** "Version X is ready. Install now / Later", under the header. Later hides it until the app restarts. */
export function UpdateBanner({ status }: { status: UpdateStatus | null }) {
  const confirm = useConfirm();
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);
  if (!status || status.phase !== 'ready' || status.required || hiddenFor === status.version) return null;

  return (
    <div className={styles.banner} role="status">
      <span className={styles.text}>
        Version {status.version} is ready to install. It takes about a minute; install when the restaurant is quiet.
      </span>
      <button className={styles.primary} onClick={() => void installUpdateWithConfirm(confirm, status.version)}>
        Install now
      </button>
      <button className={styles.secondary} onClick={() => setHiddenFor(status.version ?? '')}>
        Later
      </button>
    </div>
  );
}

/**
 * Full-screen "Update required": this version is blocked or too old (release
 * policy in the database). Shown until a newer version is installed.
 */
export function UpdateRequired({ status }: { status: UpdateStatus | null }) {
  const confirm = useConfirm();
  const [checking, setChecking] = useState(false);
  if (!status?.required) return null;

  const ready = status.phase === 'ready';
  const busy = checking || status.phase === 'checking' || status.phase === 'downloading';
  const state =
    status.phase === 'disabled'
      ? 'This copy cannot update itself. Ask your provider for the latest installer.'
      : ready
        ? `Version ${status.version} is downloaded and ready.`
        : status.phase === 'downloading'
          ? `Downloading version ${status.version ?? ''}… ${status.percent ?? 0}%`
          : status.phase === 'error'
            ? `Could not reach the update server (${status.error ?? 'unknown error'}). Check the internet and try again.`
            : 'Looking for the new version…';

  return (
    <div className={styles.required} role="alertdialog" aria-modal="true">
      <div className={styles.card}>
        <h3>Update required</h3>
        <p>{status.requiredMessage}</p>
        <p>{state}</p>
        <div className={styles.actions}>
          {status.phase !== 'disabled' && !ready && (
            <button
              className={styles.secondary}
              disabled={busy}
              onClick={async () => {
                setChecking(true);
                try {
                  await window.api.checkForUpdates();
                } finally {
                  setChecking(false);
                }
              }}
            >
              Check again
            </button>
          )}
          {ready && (
            <button className={styles.primary} onClick={() => void installUpdateWithConfirm(confirm, status.version)}>
              Install now
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
