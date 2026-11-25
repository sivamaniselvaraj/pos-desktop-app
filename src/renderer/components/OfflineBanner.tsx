import { useEffect, useState } from 'react';
import type { OfflineStatus } from '@shared/offlineTypes';
import { Icon } from './Icon';
import { shortTime } from '../lib/offline';
import styles from '../styles/OfflineBanner.module.css';

/**
 * Offline mode banner (docs/OFFLINE_MODE.md section 9), under the header.
 *  - Offline: what still works (menu and settings from this
 *    computer's copy) and what does not yet (tables, orders, KOTs, payments).
 *    Hidden with OK until the next time the connection drops.
 *  - Disk nearly full, or the local database could not be opened: a warning
 *    that stays.
 */
export function OfflineBanner({ status }: { status: OfflineStatus | null }) {
  // The `since` of the offline spell the user closed; a new spell shows the banner again.
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);
  const offline = status?.state === 'offline';

  useEffect(() => {
    if (!offline) setHiddenFor(null);
  }, [offline]);

  if (!status) return null;

  if (offline && hiddenFor !== status.since) {
    const copy =
      status.localStore === 'ready' && status.localCopyAt
        ? `The menu and settings come from this computer's copy, saved ${shortTime(status.localCopyAt)}.`
        : 'Nothing has been saved on this computer yet, so pages that need the database will not load.';
    return (
      <div className={styles.banner} role="status">
        <span className={styles.icon}>
          <Icon name="alert" size={16} />
        </span>
        <span className={styles.text}>
          <strong>No internet connection</strong> since {shortTime(status.since)}. {copy} The table board, placing
          orders, printing KOTs and bills and taking payment need the internet in this version.
        </span>
        <button className={styles.close} onClick={() => setHiddenFor(status.since)}>
          OK
        </button>
      </div>
    );
  }

  if (status.lowDisk) {
    return (
      <div className={`${styles.banner} ${styles.danger}`} role="alert">
        <span className={styles.icon}>
          <Icon name="alert" size={16} />
        </span>
        <span className={styles.text}>
          <strong>The disk is nearly full</strong> ({status.freeMb ?? 0} MB free). Free some space so the app can keep
          its offline copy and backups.
        </span>
      </div>
    );
  }

  return null;
}
