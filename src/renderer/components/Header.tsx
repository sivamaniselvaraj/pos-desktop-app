import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { AlertBell } from './AlertBell';
import type { DesktopAlert } from '@shared/alertTypes';
import { useAuth } from '../context/AuthContext';
import type { ServerStatus } from '@shared/types';
import type { OfflineStatus } from '@shared/offlineTypes';
import { connectionLabel, localCopyLine, shortTime } from '../lib/offline';
import styles from '../styles/Header.module.css';

interface HeaderProps {
  server: ServerStatus | null;
  /** Offline mode: online / offline / syncing (docs/OFFLINE_MODE.md). */
  offline: OfflineStatus | null;
  /** Installed app version (from the update status), shown as "Beta v1.0.0" beside the title. */
  version?: string;
  onRefresh: () => void;
  /** A click on an alert in the bell, or its Settings link (docs/DESKTOP_ALERTS.md). */
  onOpenAlert: (alert: DesktopAlert | 'settings') => void;
}

/**
 * One slim row: title + version badge + outlet on the left; Server and DB
 * status dots, an info icon (IP, port and status details on hover/focus),
 * a Refresh icon button and the user's avatar (initials) on the right.
 * Clicking the avatar opens a menu with name, email, role, outlet and Sign out.
 * A dot is green with no text when all is well, red with a word when down.
 */
/** Up to two initials from the name (or the email's first letter). */
function initials(name: string): string {
  const parts = name
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters =
    parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

export function Header({ server, offline, version, onRefresh, onOpenAlert }: HeaderProps) {
  const { user, signOut } = useAuth();
  const online = server?.running ?? false;
  const state = offline?.state ?? (server?.database === 'connected' ? 'online' : 'unknown');
  const conn = offline ? connectionLabel(offline) : server?.database === 'connected' ? 'Online' : 'Checking';
  const connClass =
    state === 'offline' ? styles.down : state === 'syncing' ? styles.sync : state === 'online' ? styles.ok : styles.wait;
  const connTitle =
    state === 'offline'
      ? `No internet connection since ${shortTime(offline?.since)}. Showing this computer's copy.`
      : state === 'syncing'
        ? "Online. Updating this computer's copy of the menu and settings."
        : state === 'online'
          ? 'Database connected'
          : 'Checking the connection';
  const [menuOpen, setMenuOpen] = useState(false);
  const personaRef = useRef<HTMLDivElement>(null);

  // Close the account menu on a click outside it or on Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (personaRef.current && !personaRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const displayName = user ? user.fullName || user.email : '';

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
        <div className={`${styles.dot} ${connClass}`} title={connTitle} role="status">
          <span className={styles.dotMark} />
          {conn}
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
              <strong>
                {state === 'offline'
                  ? `Offline since ${shortTime(offline?.since)}`
                  : state === 'unknown'
                    ? 'Checking'
                    : 'Connected'}
              </strong>
            </div>
            <div className={styles.tipRow}>
              <span>Offline copy</span>
              <strong>{localCopyLine(offline)}</strong>
            </div>
            {version && (
              <div className={styles.tipRow}>
                <span>Version</span>
                <strong>Beta {version}</strong>
              </div>
            )}
          </div>
        </div>

        <AlertBell onOpen={onOpenAlert} />

        <button
          className={styles.iconBtn}
          onClick={onRefresh}
          title="Refresh app"
          aria-label="Refresh app"
        >
          <Icon name="retry" size={16} />
        </button>

        {user && (
          <div className={styles.persona} ref={personaRef}>
            <button
              className={`${styles.personaBtn} ${menuOpen ? styles.personaOpen : ''}`}
              onClick={() => setMenuOpen((o) => !o)}
              title={displayName}
              aria-label="Account menu"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <span className={styles.avatar}>{initials(displayName)}</span>
              <svg
                className={styles.chevron}
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            {menuOpen && (
              <div className={styles.menu} role="menu">
                <div className={styles.menuHead}>
                  <span className={`${styles.avatar} ${styles.avatarLg}`}>
                    {initials(displayName)}
                  </span>
                  <div className={styles.menuWho}>
                    <strong>{displayName}</strong>
                    {user.fullName && <span className={styles.menuEmail}>{user.email}</span>}
                    {user.role && <span className={styles.rolePill}>{user.role}</span>}
                  </div>
                </div>
                {user.outletName && (
                  <div className={styles.menuRow}>
                    <span>Outlet</span>
                    <strong>{user.outletName}</strong>
                  </div>
                )}
                <button
                  className={styles.signOut}
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    void signOut();
                  }}
                >
                  <Icon name="logout" size={16} />
                  Sign out
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
