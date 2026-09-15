import { app } from 'electron';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

// Loads config from environment variables (.env.local) with sensible defaults,
// and persists user-changeable settings to a small JSON file in userData.
// (Replaces electron-store, which is now ESM-only and incompatible with a
// CommonJS main process.)

interface PersistedSettings {
  cashierPrinter?: string;
  kitchenPrinter?: string;
  waiterPrinter?: string;
  autoRetry?: boolean;
  retryCount?: number;
}

let fileCache: PersistedSettings | null = null;
let settingsPath: string | null = null;

function getSettingsPath(): string {
  if (!settingsPath) {
    const dir = app.isPackaged ? app.getPath('userData') : app.getAppPath();
    settingsPath = join(dir, 'settings.json');
  }
  return settingsPath;
}

function loadFile(): PersistedSettings {
  if (fileCache) return fileCache;
  try {
    const raw = readFileSync(getSettingsPath(), 'utf8');
    fileCache = JSON.parse(raw) as PersistedSettings;
  } catch {
    fileCache = {};
  }
  return fileCache;
}

function persist(patch: Partial<PersistedSettings>): void {
  const current = loadFile();
  Object.assign(current, patch);
  try {
    const path = getSettingsPath();
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(current, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist settings:', err);
  }
}


export const config = {
  get http() {
    return {
      port: Number(process.env.HTTP_PORT || 5000),
      host: process.env.HTTP_HOST || '0.0.0.0',
      // Comma-separated list of browser origins allowed to call this server
      // cross-origin, e.g. "http://localhost:3000,https://dashboard.example.com".
      // Deliberately NOT relevant to the Android app or curl/Postman — CORS is
      // a browser-only mechanism, enforced by fetch()/XHR, not by native HTTP
      // clients — so leaving this empty does not block Android. It only stops
      // an arbitrary web page the operator happens to have open from making a
      // background fetch() to this local server and reading the response.
      allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    };
  },
  get supabase() {
    return {
      url: process.env.SUPABASE_URL || '',
      anonKey: process.env.SUPABASE_ANON_KEY || '',
      table: process.env.SUPABASE_TABLE || 'orders',
      // DANGER: bypasses Row Level Security entirely. Used ONLY by
      // userAdmin.ts's createUser() (creating a login requires Supabase's Auth
      // Admin API, which requires this key — no way around it). Every call
      // site using this key must perform its own admin-role check via the
      // normal session client first; RLS provides no protection here.
      //
      // Deliberately NEVER read from embeddedConfig — see .env.build.example
      // and scripts/embed-config.js, which actively refuses to build if this
      // key is present in .env.build. This must only come from a
      // machine-local .env.local on an admin-trusted machine.
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    };
  },
  // Each of these reads the ENV fallback fresh on every access (never
  // cached) and only falls back to it when settings.json has no value yet.
  get cashierPrinter(): string {
    return loadFile().cashierPrinter ?? process.env.CASHIER_PRINTER ?? '';
  },
  set cashierPrinter(value: string) {
    persist({ cashierPrinter: value });
  },
  get kitchenPrinter(): string {
    return loadFile().kitchenPrinter?? process.env.KITCHEN_PRINTER ?? '';
  },
  set kitchenPrinter(value: string) {
    //load().kitchenPrinter = 'HP_Smart_Tank_580_590_series__8E5406_';
    persist({ kitchenPrinter: value });
  },
  get waiterPrinter(): string {
    return loadFile().kitchenPrinter?? process.env.WAITER_PRINTER ?? '';
  },
  set waiterPrinter(value: string) {
    //load().waiterPrinter = 'RP3160 GOLD(U) 1';
    persist({ waiterPrinter: value });
  },
  get autoRetry(): boolean {
    return loadFile().autoRetry ?? true;
  },
  get retryCount(): number {
    return loadFile().retryCount ?? 3;
  },
};

export const isConfigured = (): boolean =>
  Boolean(config.supabase.url && config.supabase.anonKey);

/**
 * Manually save/persist config to disk
 */
export function saveConfig(): void {
  //persist();
}
