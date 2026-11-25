/**
 * data/index.ts
 * ---------------------------------------------------------------------------
 * The only entry point managers use to reach the database:
 *
 *     import { db } from './data';
 *     const rows = await db.tables.listCards();
 *
 * The provider is chosen by DB_PROVIDER (env or .env.local), default
 * "supabase". To add another database: create data/<name>/index.ts exporting a
 * DataProvider factory and register it below.
 * ---------------------------------------------------------------------------
 */
import type { DataProvider } from './ports';
import { createSupabaseProvider } from './supabase';
import { OfflineMode } from './offline';
import { timedWatch, trackLocalWrites } from './live';
import type { LiveRepository } from './ports';

export type * from './ports';
export type { ConnectivitySnapshot, ConnectivityState, LocalStoreInfo, OfflineStatusParts } from './offline';
export { OfflineError, OFFLINE_MESSAGE } from './offline';
export { onLocalWrite } from './live';

const factories: Record<string, () => DataProvider> = {
  supabase: createSupabaseProvider,
  // postgres: createPostgresProvider,
};

let active: DataProvider | null = null;

export function getProvider(): DataProvider {
  if (!active) {
    const name = (process.env.DB_PROVIDER || 'supabase').toLowerCase();
    const factory = factories[name];
    if (!factory) {
      throw new Error(`Unknown DB_PROVIDER "${name}". Available: ${Object.keys(factories).join(', ')}.`);
    }
    active = factory();
  }
  return active;
}

/**
 * Offline mode (docs/OFFLINE_MODE.md): the health check, the local database
 * and the wrapper that saves reference reads and answers them offline. The
 * health check uses the provider's own isReachable, never the wrapped one.
 */
export const offline = new OfflineMode(async () => {
  const p = getProvider();
  return p.isConfigured() && p.orders.isReachable();
});

type Repos = Omit<DataProvider, 'name' | 'isConfigured' | 'checkConnection' | 'live'>;
function repo<K extends keyof Repos>(name: K): Repos[K] {
  return trackLocalWrites(name, offline.facade.wrap(name, getProvider()[name]));
}

/**
 * Live updates (docs/LIVE_UPDATES.md): the provider's own watch, paused while
 * offline, or a timed reload when the provider has none.
 */
const live: LiveRepository = {
  watch(outletId, onChange) {
    const isPaused = () => offline.monitor.isOffline();
    const p = getProvider().live;
    return p ? p.watch(outletId, onChange, { isPaused }) : timedWatch(onChange, { isPaused });
  },
};

/** Lazy facade so modules can `import { db }` before the environment is loaded. */
export const db: DataProvider = {
  get name() {
    return getProvider().name;
  },
  isConfigured: () => getProvider().isConfigured(),
  checkConnection: (url, token) => getProvider().checkConnection(url, token),
  get auth() {
    return repo('auth');
  },
  get access() {
    return repo('access');
  },
  get orders() {
    return repo('orders');
  },
  get orderAdmin() {
    return repo('orderAdmin');
  },
  get orderEntry() {
    return repo('orderEntry');
  },
  get tax() {
    return repo('tax');
  },
  get remoteOrders() {
    return repo('remoteOrders');
  },
  get devices() {
    return repo('devices');
  },
  get kots() {
    return repo('kots');
  },
  get tables() {
    return repo('tables');
  },
  get menu() {
    return repo('menu');
  },
  get users() {
    return repo('users');
  },
  get groups() {
    return repo('groups');
  },
  get invoices() {
    return repo('invoices');
  },
  get reports() {
    return repo('reports');
  },
  get releases() {
    return repo('releases');
  },
  live,
};
