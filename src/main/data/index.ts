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

export type * from './ports';

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

/** Lazy facade so modules can `import { db }` before the environment is loaded. */
export const db: DataProvider = {
  get name() {
    return getProvider().name;
  },
  isConfigured: () => getProvider().isConfigured(),
  get auth() {
    return getProvider().auth;
  },
  get access() {
    return getProvider().access;
  },
  get orders() {
    return getProvider().orders;
  },
  get orderAdmin() {
    return getProvider().orderAdmin;
  },
  get orderEntry() {
    return getProvider().orderEntry;
  },
  get tax() {
    return getProvider().tax;
  },
  get tables() {
    return getProvider().tables;
  },
  get menu() {
    return getProvider().menu;
  },
  get users() {
    return getProvider().users;
  },
  get groups() {
    return getProvider().groups;
  },
  get invoices() {
    return getProvider().invoices;
  },
  get reports() {
    return getProvider().reports;
  },
};
