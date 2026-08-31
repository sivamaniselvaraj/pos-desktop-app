import { useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { Dashboard } from './pages/Dashboard';
import { Settings } from './pages/Settings';
import { History } from './pages/History';
import { SalesReport } from './pages/SalesReport';
import { About } from './pages/About';
import { Login } from './pages/Login';
import { useStatus } from './hooks/useStatus';
import { useAuth } from './context/AuthContext';
import styles from './styles/App.module.css';
import { UserManagement } from './pages/UserManagement';

export default function App() {
  const { user, loading } = useAuth();
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

  return (
    <div className={styles.app}>
      <Sidebar active={page} onNavigate={setPage} printers={printers} />
      <main className={styles.main}>
        <Header server={server} onRefresh={handleRefresh} />
        <div className={styles.body}>
          {page === 'dashboard' && <Dashboard />}
          {page === 'settings' && <Settings />}
          {page === 'history' && <History />}
          {page === 'sales-report' && <SalesReport />}
          {page === 'users' && <UserManagement />}
          {page === 'about' && <About />}
        </div>
      </main>
    </div>
  );
}
