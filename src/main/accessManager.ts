import { db } from './data';
import type { AccessMenu, MyAccess } from '../shared/types';

/**
 * accessManager.ts
 * ---------------------------------------------------------------------------
 * Loads the signed-in user's permissions and sidebar menus from the database
 * (get_my_access). This drives what the UI SHOWS; the database still enforces
 * what the user may DO.
 *
 * If get_my_access() isn't deployed yet, falls back to the rules that used to
 * be hardcoded in the Sidebar, so the app keeps working during rollout.
 * Remove the fallback once the SQL is live everywhere.
 * ---------------------------------------------------------------------------
 */

const ALL = ['dashboard.view', 'history.view', 'menu.view', 'settings.view', 'about.view'];
const FALLBACK_PERMS: Record<string, string[]> = {
  staff: [...ALL, 'orders.place', 'tables.view'],
  manager: [...ALL, 'orders.place', 'tables.view', 'tables.manage', 'orders.view', 'menu.edit', 'reports.view'],
  owner: [...ALL, 'orders.place', 'tables.view', 'tables.manage', 'orders.view', 'menu.edit', 'reports.view'],
  admin: [...ALL, 'orders.place', 'tables.view', 'tables.manage', 'orders.view', 'menu.edit', 'reports.view', 'users.manage'],
};
// editor: approvals only, no console access.

const FALLBACK_MENUS: (AccessMenu & { perm: string })[] = [
  { code: 'dashboard', label: 'Dashboard', icon: 'dashboard', perm: 'dashboard.view' },
  { code: 'new-order', label: 'New Order', icon: 'plus', perm: 'orders.place' },
  { code: 'history', label: 'History', icon: 'history', perm: 'history.view' },
  { code: 'orders-list', label: 'Orders', icon: 'orders', perm: 'orders.view' },
  { code: 'tables', label: 'Tables', icon: 'table', perm: 'tables.view' },
  { code: 'menu-items', label: 'Menu Items', icon: 'foodMenu', perm: 'menu.view' },
  { code: 'sales-report', label: 'Sales Report', icon: 'reports', perm: 'reports.view' },
  { code: 'users', label: 'Users', icon: 'users', perm: 'users.manage' },
  { code: 'settings', label: 'Settings', icon: 'settings', perm: 'settings.view' },
  { code: 'about', label: 'About', icon: 'info', perm: 'about.view' },
];

export function fallbackAccess(role: string): MyAccess {
  const perms = FALLBACK_PERMS[role.toLowerCase()] ?? [];
  return {
    role,
    org: null,
    permissions: perms,
    menus: FALLBACK_MENUS.filter((m) => perms.includes(m.perm)).map(({ code, label, icon }) => ({ code, label, icon })),
    fallback: true,
  };
}

export async function getMyAccess(): Promise<MyAccess | null> {
  const access = await db.access.fetchMyAccess();
  if (access) return access;
  // Not available (older database) or a transient failure: fall back to the
  // built-in rules based on the role from the session.
  const role = await db.access.fetchSessionRole();
  return role === null ? null : fallbackAccess(role);
}
