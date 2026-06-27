import { Icon } from './Icon';
import { useAuth } from '../context/AuthContext';
import type { ServerStatus } from '@shared/types';
import styles from '../styles/Header.module.css';

interface HeaderProps {
  server: ServerStatus | null;
  onRefresh: () => void;
}

export function Header({ server, onRefresh }: HeaderProps) {
  const { user, signOut } = useAuth();
  const online = server?.running ?? false;
  const dbConnected = server?.database === 'connected';

  return (
    <header className={styles.header}>
      <h1 className={styles.title}>Food Order Printer</h1>
      <div className={styles.actions}>
        <div className={`${styles.status} ${online ? styles.statusOnline : styles.statusOffline}`}>
          <span className={styles.statusDot} />
          Server: {online ? `Online :${server?.port}` : 'Offline'}
        </div>
        <div className={`${styles.status} ${dbConnected ? styles.statusOnline : styles.statusOffline}`}>
          <span className={styles.statusDot} />
          DB: {dbConnected ? 'Connected' : 'Disconnected'}
        </div>
        <button className={styles.btn} onClick={onRefresh}>
          <Icon name="retry" size={16} />
          Refresh
        </button>

        {user && (
          <div className={styles.user}>
            <span className={styles.userIcon}>
              <Icon name="user" size={16} />
            </span>
            <span className={styles.userInfo}>
              <span className={styles.userName}>{user.fullName || user.email}</span>
              <span className={styles.userRole}>{user.role}</span>
            </span>
            <button className={styles.logout} onClick={signOut} title="Sign out" aria-label="Sign out">
              <Icon name="logout" size={16} />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
