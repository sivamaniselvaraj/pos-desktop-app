import { lazy, Suspense, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import styles from '../styles/ReportsPage.module.css';
import { SalesOverview } from './reports/SalesOverview';

// Every tab except Overview (pages/reports/SalesOverview.tsx) loads on demand,
// so opening the report only fetches Overview's code. Recharts sits in its own
// "charts" chunk (vite.config.ts).
const DailySummaryTab = lazy(() =>
  import('./reports/DailySummary').then((m) => ({ default: m.DailySummaryTab })),
);
const HourlySalesTab = lazy(() =>
  import('./reports/HourlySales').then((m) => ({ default: m.HourlySalesTab })),
);
const ProductMixTab = lazy(() =>
  import('./reports/ProductMix').then((m) => ({ default: m.ProductMixTab })),
);
const ChannelSalesTab = lazy(() =>
  import('./reports/ChannelSales').then((m) => ({ default: m.ChannelSalesTab })),
);
const SalesByWaiterTab = lazy(() =>
  import('./reports/SalesByWaiter').then((m) => ({ default: m.SalesByWaiterTab })),
);
const MenuAvailabilityTab = lazy(() =>
  import('./reports/MenuAvailability').then((m) => ({ default: m.MenuAvailabilityTab })),
);
const VoidsDiscountsTab = lazy(() =>
  import('./reports/VoidsDiscounts').then((m) => ({ default: m.VoidsDiscountsTab })),
);

const tabLoading = <div style={{ padding: 24, color: 'var(--gray)' }}>Loading…</div>;

export function Reports() {
  const { can, user } = useAuth();
  // Each extra tab needs reports.view (to be on this page at all) plus its own permission.
  const canWaiterReport = can('reports.view') && can('reports.incentive');
  const canMenuReport = can('reports.view') && can('reports.menu_availability');
  const canVoidsReport = can('reports.view') && can('reports.voids');
  const [tab, setTab] = useState<
    'overview' | 'daily' | 'hourly' | 'pmix' | 'channels' | 'waiters' | 'menu' | 'voids'
  >('overview');

  const tabs: { key: typeof tab; label: string; show: boolean }[] = [
    { key: 'overview', label: 'Overview', show: true },
    // Daily summary, Hourly, Product mix and Channels need only reports.view, like Overview (docs/SALES_REPORTS.md).
    { key: 'daily', label: 'Daily summary', show: true },
    { key: 'hourly', label: 'Hourly', show: true },
    { key: 'pmix', label: 'Product mix', show: true },
    { key: 'channels', label: 'Channels & categories', show: true },
    { key: 'waiters', label: 'By waiter', show: canWaiterReport },
    { key: 'menu', label: 'Menu availability', show: canMenuReport },
    { key: 'voids', label: 'Voids and discounts', show: canVoidsReport },
  ];
  // A tab the user may not open (for example after a permission change) falls back to Overview.
  const active = tabs.find((t) => t.key === tab && t.show)?.key ?? 'overview';

  return (
    <div className={styles.tabsShell}>
      <div className={styles.topTabs} role="tablist">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={active === t.key}
              className={`${styles.topTab} ${active === t.key ? styles.topTabOn : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
      </div>
      <Suspense fallback={tabLoading}>
        {active === 'daily' ? (
          <DailySummaryTab outletId={user?.outletId!}/>
        ) : active === 'hourly' ? (
          <HourlySalesTab outletId={user?.outletId!}/>
        ) : active === 'pmix' ? (
          <ProductMixTab outletId={user?.outletId!}/>
        ) : active === 'channels' ? (
          <ChannelSalesTab outletId={user?.outletId!}/>
        ) : active === 'waiters' ? (
          <SalesByWaiterTab outletId={user?.outletId!}/>
        ) : active === 'menu' ? (
          <MenuAvailabilityTab outletId={user?.outletId!}/>
        ) : active === 'voids' ? (
          <VoidsDiscountsTab outletId={user?.outletId!}/>
        ) : (
          <SalesOverview outletId={user?.outletId!} />
        )}
      </Suspense>
    </div>
  );
}
