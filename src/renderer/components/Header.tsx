import { Icon } from './Icon';
import { useAuth } from '../context/AuthContext';
import type { ServerStatus, UpdateStatus } from '@shared/types';
import styles from '../styles/Header.module.css';

interface HeaderProps {
  server: ServerStatus | null;
  /** Installed app version (from the update status), shown as "Beta v1.0.0" beside the title. */
  version?: string;
  onRefresh: () => void;
}

/**
 * One slim row: title + version badge + outlet on the left; Server and DB
 * status dots, an info icon (IP, port and status details on hover/focus),
 * a Refresh icon button and the user's name + sign out on the right.
 * A dot is green with no text when all is well, red with a word when down.
 */
export function Header({ server, version, onRefresh }: HeaderProps) {
  const { user, signOut } = useAuth();
  const online = server?.running ?? false;
  const dbConnected = server?.database === 'connected';

  return (
    <header className={styles.header}>
      <div className={styles.titleBlock}>
        <h1 className={styles.title}>Virunthagam POS</h1>
        {version && <span className={styles.version}>Beta {version}</span>}
        {user?.outletName && (
          <>
            <span className={styles.sep} aria-hidden="true" />
            <span className={styles.outletName}>{user.outletName}</span>
          </>
        )}
      </div>
      <div className={styles.actions}>
        <div
          className={`${styles.dot} ${online ? styles.ok : styles.down}`}
          title={online ? `Server online on port ${server?.port}` : 'Server offline'}
        >
          <span className={styles.dotMark} />
          {online ? 'Server' : 'Server offline'}
        </div>
        <div
          className={`${styles.dot} ${dbConnected ? styles.ok : styles.down}`}
          title={dbConnected ? 'Database connected' : 'Database disconnected'}
        >
          <span className={styles.dotMark} />
          {dbConnected ? 'DB' : 'DB disconnected'}
        </div>

        <div className={styles.info} tabIndex={0} aria-label="Connection details">
          <Icon name="info" size={16} />
          <div className={styles.tooltip} role="tooltip">
            <div className={styles.tipRow}>
              <span>IP address</span>
              <strong>{server?.ipAddress ?? 'No network'}</strong>
            </div>
            <div className={styles.tipRow}>
              <span>Phone API</span>
              <strong>{online ? `Online, port ${server?.port}` : 'Offline'}</strong>
            </div>
            <div className={styles.tipRow}>
              <span>Database</span>
              <strong>{dbConnected ? 'Connected' : 'Disconnected'}</strong>
            </div>
            {user?.role && (
              <div className={styles.tipRow}>
                <span>Signed in as</span>
                <strong className={styles.role}>{user.role}</strong>
              </div>
            )}
            {version && (
              <div className={styles.tipRow}>
                <span>Version</span>
                <strong>Beta v{version}</strong>
              </div>
            )}
          </div>
        </div>

        <button className={styles.iconBtn} onClick={onRefresh} title="Refresh app" aria-label="Refresh app">
          <Icon name="retry" size={16} />
        </button>

        {user && (
          <div className={styles.user}>
            <span className={styles.userInfo}>
              <span className={styles.userName}>{user.fullName || user.email}</span>
            </span>
            <button className={styles.iconBtn} onClick={signOut} title="Sign out" aria-label="Sign out">
              <Icon name="logout" size={16} />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
