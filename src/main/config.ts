import { app } from 'electron';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

// Loads config from environment variables (.env.local) with sensible defaults,
// and persists user-changeable settings to a small JSON file in userData.
// (Replaces electron-store, which is now ESM-only and incompatible with a
// CommonJS main process.)

interface PersistedSettings {
  cashierPrinter?: string;
  waiterPrinter?: string;
  kitchenPrinter?: string;
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
      orderTable: process.env.SUPABASE_TABLE || 'orders',
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
  // Which outlet THIS machine serves. Deliberately never read from
  // embeddedConfig — unlike SUPABASE_URL/ANON_KEY (the same value for every
  // install of this app), this is different per physical machine, so
  // baking one into a shared installer would silently misconfigure every
  // install except whichever machine's value happened to get baked in.
  // Set only via a machine-local .env.local. (scripts/embed-config.js
  // already warns and ignores unrecognized .env.build keys, which covers
  // OUTLET_ID automatically since it's intentionally not in that script's
  // safe-keys list.)
  //
  // Exists specifically so outlet-scoped background work (menu caching,
  // KOT reconciliation) can resolve an outlet WITHOUT requiring anyone to
  // be logged into the desktop UI at that moment — unlike the admin pages
  // (Sales Report, Orders List, User Management), which all resolve outlet
  // via the signed-in user's profile and can tolerate pausing while logged
  // out, a menu endpoint Android depends on all day cannot.
  get outletId(): string {
    return process.env.OUTLET_ID ?? '';
  },
  // Each of these reads the ENV fallback fresh on every access (never
  // cached) and only falls back to it when settings.json has no value yet.
  get cashierPrinter(): string {
    return loadFile().cashierPrinter ?? process.env.CASHIER_PRINTER ?? '';
  },
  set cashierPrinter(value: string) {
    persist({ cashierPrinter: value });
  },
  get waiterPrinter(): string {
    return loadFile().waiterPrinter ?? process.env.WAITER_PRINTER ?? '';
  },
  set waiterPrinter(value: string) {
    persist({ waiterPrinter: value });
  },
  get kitchenPrinter(): string {
    return loadFile().kitchenPrinter ?? process.env.KITCHEN_PRINTER ?? '';
  },
  set kitchenPrinter(value: string) {
    persist({ kitchenPrinter: value });
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
