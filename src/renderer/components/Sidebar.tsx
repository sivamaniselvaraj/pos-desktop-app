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

const NAV: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'history', label: 'History', icon: 'history' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
  { id: 'about', label: 'About', icon: 'info' },
];

// Roles allowed to see the Sales Report nav item. This is convenience/UX
// only — the real access boundary is enforced server-side by the report
// RPCs (get_sales_report / get_top_items check the caller's role via
// auth.uid()), so hiding the link here doesn't substitute for that.
const REPORT_ROLES = ['manager', 'owner', 'admin'];

// User Management is admin-only (narrower than the report page). Same
// caveat: real enforcement is server-side (is_admin() / the user-management
// RPCs), this only controls whether the link is shown.
const USER_MANAGEMENT_ROLES = ['admin'];

interface SidebarProps {
  active: string;
  onNavigate: (id: string) => void;
  printers: PrinterInfo[];
}

export function Sidebar({ active, onNavigate, printers }: SidebarProps) {
  const { user } = useAuth();
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

    const role = user?.role.toLowerCase();
  const canViewReports = !!role && REPORT_ROLES.includes(role);
  const canManageUsers = !!role && USER_MANAGEMENT_ROLES.includes(role);
  // Dashboard, History, [Sales Report], [Users], Settings, About — the
  // conditional items are inserted between History and Settings in that order.
  const navItems: NavItem[] = [
    ...NAV.slice(0, 2),
    ...(canViewReports
      ? [{ id: 'sales-report', label: 'Sales Report', icon: 'reports' as IconName }]
      : []),
    ...(canManageUsers ? [{ id: 'users', label: 'Users', icon: 'users' as IconName }] : []),
    ...NAV.slice(2),
  ];

  return (
    <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`}>
      <button className={styles.toggle} onClick={toggle} title="Toggle sidebar" aria-label="Toggle sidebar">
        <Icon name="menu" size={18} />
      </button>

      <div className={styles.logo}>
        <span className={styles.logoIcon}>
          <Icon name="printer" size={18} />
        </span>
        {!collapsed && <span className={styles.logoText}>PrintPro</span>}
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
