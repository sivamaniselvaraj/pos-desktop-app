import { useState } from 'react';
import { Icon, type IconName } from './Icon';
import { useAuth } from '../context/AuthContext';
import type { PrinterInfo } from '@shared/types';
import styles from '../styles/Sidebar.module.css';

interface NavItem {
  id: string;
  label: string;
  icon: IconName;
}

// Sidebar entries come from the database (app_menus filtered by the user's
// permissions, via get_my_access). Hiding a link is a UX nicety only — the
// real access boundary is enforced server-side by RLS and the RPCs. Icon
// names from the database are checked against the icons bundled in the app.
const KNOWN_ICONS = new Set<string>([
  'printer', 'dashboard', 'history', 'reports', 'settings', 'info', 'menu', 'print', 'table', 'foodMenu', 'orders', 
  'refresh', 'plus', 'check', 'trash', 'lock', 'logout', 'user', 'users', 'edit', 'view', 'save',
]);

interface SidebarProps {
  active: string;
  onNavigate: (id: string) => void;
  printers: PrinterInfo[];
}

export function Sidebar({ active, onNavigate, printers }: SidebarProps) {
  const { access } = useAuth();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('sidebarCollapsed') === 'true',
  );

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('sidebarCollapsed', String(next));
      return next;
    });
  };

  const navItems: NavItem[] = (access?.menus ?? []).map((m) => ({
    id: m.code,
    label: m.label,
    icon: (KNOWN_ICONS.has(m.icon) ? m.icon : 'info') as IconName,
  }));

  return (
    <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`}>
      <button className={styles.toggle} onClick={toggle} title="Toggle sidebar" aria-label="Toggle sidebar">
        <Icon name="menu" size={18} />
      </button>

      <div className={styles.logo}>
        
      </div>
      <nav>
        {navItems.map((item) => (
          <button
            key={item.id}
            className={`${styles.navItem} ${active === item.id ? styles.navActive : ''}`}
            onClick={() => onNavigate(item.id)}
          >
            <Icon name={item.icon} size={20} />
            {!collapsed && <span className={styles.navText}>{item.label}</span>}
          </button>
        ))}
      </nav>

      <div className={styles.printers}>
        {!collapsed && <h3 className={styles.printersTitle}>Printers</h3>}
        {printers.length === 0 && !collapsed && (
          <div className={styles.printerEmpty}>No printers found</div>
        )}
        {printers.map((printer) => (
          <div key={printer.name} className={styles.printerItem} title={printer.name}>
            <span
              className={`${styles.dot} ${printer.online ? styles.dotOnline : styles.dotOffline}`}
            />
            {!collapsed && (
              <>
                <span className={styles.printerName}>{printer.name}</span>
                <span className={styles.printerStatus}>
                  {printer.online ? 'Online' : 'Offline'}
                </span>
              </>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
