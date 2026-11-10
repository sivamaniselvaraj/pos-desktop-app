import { ConnectionConfig } from '../shared/connectionTypes';

/**
 * envNames.ts
 * ---------------------------------------------------------------------------
 * Provider-neutral names for the database connection settings, with the old
 * names still accepted so PCs set up before 2026-11-09 keep working.
 *
 *   DB_URL           database URL          (old name: SUPABASE_URL)
 *   DB_KEY           auth token / API key  (old name: SUPABASE_ANON_KEY)
 *   DB_SERVICE_KEY   admin key, legacy     (old name: SUPABASE_SERVICE_ROLE_KEY)
 *   DB_ORDERS_TABLE  orders table name     (old name: SUPABASE_TABLE)
 *
 * The new name wins when both are set. Read fresh on every call: .env.local is
 * loaded after modules are imported (see the note at the top of config.ts).
 * ---------------------------------------------------------------------------
 */

export const LEGACY_ENV_NAMES = {
  DB_URL: 'SUPABASE_URL',
  DB_KEY: 'SUPABASE_ANON_KEY',
  DB_SERVICE_KEY: 'SUPABASE_SERVICE_ROLE_KEY',
  DB_ORDERS_TABLE: 'SUPABASE_TABLE',
} as const;

export type DbEnvName = keyof typeof LEGACY_ENV_NAMES;

/** process.env value under the new name, else the old name; '' when neither is set. */
export function dbEnv(name: DbEnvName): string {
  return process.env[name] || process.env[LEGACY_ENV_NAMES[name]] || '';
}

/** Value baked in from .env.build (scripts/embed-config.js already maps old names). Never the service key. */
export function dbBuilt(name: Exclude<DbEnvName, 'DB_SERVICE_KEY'>): string {
  return ConnectionConfig[name] || '';
}
