import { useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { Dashboard } from './pages/Dashboard';
import { Settings } from './pages/Settings';
import { History } from './pages/History';
import { SalesReport } from './pages/SalesReport';
import { UserManagement } from './pages/UserManagement';
import { TaxRates } from './pages/TaxRates';
import { NewOrder } from './pages/NewOrder';
import { TablesManagement } from './pages/TablesManagement';
import { OrdersList } from './pages/OrdersList';
import { MenuItemsPage } from './pages/MenuItems';
import { KotBoardPage } from './pages/KotBoard';
import { About } from './pages/About';
import { Login } from './pages/Login';
import { useStatus } from './hooks/useStatus';
import { useAuth } from './context/AuthContext';
import styles from './styles/App.module.css';

export default function App() {
  const { user, loading, access, signOut } = useAuth();
  const [page, setPage] = useState('dashboard');
  const { server, printers } = useStatus();

  const handleRefresh = () => {
    window.location.reload();
  };

  // While restoring a persisted session.
  if (loading) {
    return <div className={styles.splash}>Loading…</div>;
  }

  // Gate the operator console behind authentication + authorization.
  if (!user) {
    return <Login />;
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

  return (
    <div className={styles.app}>
      <Sidebar active={current} onNavigate={setPage} printers={printers} />
      <main className={styles.main}>
        <Header server={server} onRefresh={handleRefresh} />
        <div className={styles.body}>
          {current === 'dashboard' && <Dashboard />}
          {current === 'settings' && <Settings />}
          {current === 'history' && <History />}
          {current === 'sales-report' && <SalesReport />}
          {current === 'users' && <UserManagement />}
          {current === 'tax-rates' && <TaxRates />}
          {current === 'orders-list' && <OrdersList />}
          {current === 'tables' && <TablesManagement />}
          {current === 'new-order' && <NewOrder />}
          {current === 'menu-items' && <MenuItemsPage />}
          {current === 'kot-board' && <KotBoardPage />}
          {current === 'about' && <About />}
        </div>
      </main>
    </div>
  );
}
