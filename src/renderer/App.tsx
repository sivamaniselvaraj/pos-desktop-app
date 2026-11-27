import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { DesktopAlert } from '@shared/alertTypes';
import type { ConnectionSetupStatus } from '@shared/connectionTypes';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { Dashboard } from './pages/Dashboard';
import { History } from './pages/History';
import { NewOrder } from './pages/NewOrder';
import { TablesManagement } from './pages/TablesManagement';
import { OrdersList } from './pages/OrdersList';
import { KotBoardPage } from './pages/KotBoard';
import { UnprintedKotsPage } from './pages/UnprintedKots';
import { About } from './pages/About';
import { Login } from './pages/Login';
import { ConnectionSetup } from './pages/ConnectionSetup';
import { useStatus } from './hooks/useStatus';
import { useUpdateStatus } from './hooks/useUpdateStatus';
import { useOfflineStatus } from './hooks/useOfflineStatus';
import { OfflineBanner } from './components/OfflineBanner';
import { UpdateBanner, UpdateRequired } from './components/UpdateBanner';
import { KotAlertBanner } from './components/KotAlertBanner';
import { useAuth } from './context/AuthContext';
import { markPageOpen } from './lib/timing';
import styles from './styles/App.module.css';
import { DINE_IN_ORDER_TYPE, OrderType, PICK_UP_ORDER_TYPE } from '../shared/types';

// Pages opened rarely during service load on demand, so the app starts with a
// smaller file. The Sales report (pages/Reports.tsx) pulls in Recharts, which
// is split into its own "charts" chunk (vite.config.ts); Settings (with Tax
// rates), User management and Menu items are admin pages.
const Reports = lazy(() =>
  import('./pages/Reports').then((m) => ({ default: m.Reports })),
);
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));
const UserManagement = lazy(() =>
  import('./pages/UserManagement').then((m) => ({ default: m.UserManagement })),
);
const MenuItemsPage = lazy(() =>
  import('./pages/MenuItems').then((m) => ({ default: m.MenuItemsPage })),
);

const pageLoading = <div style={{ padding: 24, color: 'var(--gray)' }}>Loading…</div>;

export default function App() {
  const { user, loading, access, signOut } = useAuth();
  const [page, setPage] = useState('dashboard');
  const [presetTable, setPresetTable] = useState<string | null>(null);
  const [orderType, setOrderType] = useState<OrderType>(PICK_UP_ORDER_TYPE);
  const { server, printers } = useStatus();
  const update = useUpdateStatus();
  const offline = useOfflineStatus();
  // Database URL, auth token and outlet id of this PC (docs/CONNECTION_SETUP.md).
  const [setup, setSetup] = useState<ConnectionSetupStatus | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);

  useEffect(() => {
    window.api
      .getConnectionSetup()
      .then(setSetup)
      .catch(() => setSetup(null));
  }, []);

  // A click on a Windows notification opens the page for that alert (docs/DESKTOP_ALERTS.md).
  const openAlertRef = useRef<(a: DesktopAlert | 'settings') => void>(() => undefined);
  useEffect(() => window.api.onAlertOpened((a:any) => openAlertRef.current(a)), []);

  const handleRefresh = () => {
    window.location.reload();
  };

  // Nothing works without the connection values: ask for them first.
  if (setup && (!setup.complete || setupOpen)) {
    return <ConnectionSetup status={setup} onCancel={() => setSetupOpen(false)} />;
  }

  // While restoring a persisted session.
  if (loading) {
    return <div className={styles.splash}>Loading…</div>;
  }

  // Gate the operator console behind authentication + authorization.
  if (!user) {
    return (
      <>
        <Login
          onOpenSetup={
            setup
              ? () => {
                  void window.api.getConnectionSetup().then(setSetup);
                  setSetupOpen(true);
                }
              : undefined
          }
        />
        <UpdateRequired status={update} />
      </>
    );
  }

  // Permissions are still loading.
  if (!access) {
    return <div className={styles.splash}>Loading…</div>;
  }

  // Accounts with no menu entries (e.g. the approval-only editor role) have
  // nothing to do in this console.
  if (access.menus.length === 0) {
    return (
      <div className={styles.splash}>
        <div style={{ textAlign: 'center', maxWidth: 380 }}>
          <p style={{ marginBottom: 12 }}>
            This account can only approve changes (edit, delete and cancel) and has no access to
            this console.
          </p>
          <button onClick={() => void signOut()}>Sign out</button>
        </div>
      </div>
    );
  }

  // Only pages the user's menus include may be shown, even if `page` is set
  // some other way (e.g. a stale selection after a permission change).
  const allowed = new Set(access.menus.map((m) => m.code));
  const current = allowed.has(page) ? page : access.menus[0].code;

  const go = (next: string) => {
    if (!allowed.has(next) || next === current) return;
    setPresetTable(null);
    markPageOpen(next);
    setPage(next);
  };
  // The page for an alert, if this user may open it: failed KOT -> Unprinted KOTs, late -> KDS board, new order -> Dashboard.
  const openAlert = (a: DesktopAlert | 'settings') => {
    if (a === 'settings') return go('settings');
    const pages =
      a.kind === 'kot-failed' ? ['unprinted-kots', 'orders-list'] : a.kind === 'late' ? ['kot-board', 'orders-list', 'dashboard'] : ['dashboard', 'orders-list'];
    const target = pages.find((p) => allowed.has(p));
    if (target) go(target);
  };
  openAlertRef.current = openAlert;

  return (
    <div className={styles.app}>
      <Sidebar
        active={current}
        onNavigate={(next) => {
          // The sidebar always opens a fresh New order (Pickup), never one left over from a Dashboard table.
          setPresetTable(null);
          markPageOpen(next); // screen timing starts at the tap (docs/TIMINGS.md)
          setOrderType(PICK_UP_ORDER_TYPE);
          setPage(next);
        }}
        printers={printers}
      />
      <main className={styles.main}>
        <Header
          server={server}
          offline={offline}
          version={update?.currentVersion}
          onRefresh={handleRefresh}
          onOpenAlert={openAlert}
        />
        <OfflineBanner status={offline} />
        <KotAlertBanner onOpenUnprinted={allowed.has('unprinted-kots') ? () => go('unprinted-kots') : undefined} />
        <UpdateBanner status={update} />
        <div className={styles.body}>
          <Suspense fallback={pageLoading}>
            {current === 'dashboard' && (
              <Dashboard
                onAddItems={
                  allowed.has('new-order')
                    ? (tableId) => {
                        setPresetTable(tableId);
                        markPageOpen('new-order');
                        setOrderType(DINE_IN_ORDER_TYPE)
                        setPage('new-order');
                      }
                    : undefined
                }
                onNewTakeaway={
                  allowed.has('new-order')
                    ? () => {
                        setPresetTable(null); // a fresh order opens on Pickup
                        markPageOpen('new-order');
                        setOrderType(PICK_UP_ORDER_TYPE)
                        setPage('new-order');
                      }
                    : undefined
                }
              />
            )}
            {current === 'settings' && <Settings />}
            {current === 'history' && <History />}
            {current === 'sales-report' && <Reports />}
            {current === 'users' && <UserManagement />}
            {current === 'orders-list' && (
              <OrdersList
                onNewOrder={
                  allowed.has('new-order')
                    ? () => {
                        setPresetTable(null); // a fresh order, not one left over from a table
                        markPageOpen('new-order');
                        setPage('new-order');
                      }
                    : undefined
                }
              />
            )}
            {current === 'tables' && <TablesManagement />}
            {current === 'new-order' && (
              <NewOrder key={presetTable ?? 'none'} initialTableId={presetTable} initialOrderType={orderType}/>
            )}
            {current === 'menu-items' && <MenuItemsPage />}
            {current === 'kot-board' && <KotBoardPage />}
            {current === 'unprinted-kots' && <UnprintedKotsPage />}
            {current === 'about' && <About update={update} />}
          </Suspense>
        </div>
      </main>
      <UpdateRequired status={update} />
    </div>
  );
}
