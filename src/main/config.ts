import { app } from 'electron';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
//import { embeddedConfig } from './embeddedConfig';

// Loads config from three layers, in priority order:
//   1. process.env (OS-level env vars, or .env.local loaded by index.ts's
//      loadEnv() into process.env before app startup completes)
//   2. embeddedConfig (baked in at build time from .env.build — see
//      scripts/embed-config.js — so a packaged install works with zero
//      manual setup)
//   3. hardcoded literal fallback
//
// IMPORTANT — this file must never let an env-var-backed value get computed
// ONCE and cached. config.ts gets require()'d transitively through
// index.ts's top-level imports, which Node evaluates synchronously — BEFORE
// app.whenReady().then(() => loadEnv()) has run. Two different mistakes both
// lead to the same symptom (a value stays '' forever even though .env.local
// clearly has it) and BOTH have actually occurred in this file at different
// times:
//   (a) A plain object literal for provider settings/config.http would freeze
//       process.env.SUPABASE_URL etc. at module-import time. Fixed by
//       making these GETTERS, which re-read process.env on every access.
//   (b) Less obviously: a getter alone isn't enough if it's backed by a
//       memoized function. config.cashierPrinter used to call load(), which
//       cached its result in a module-level `cache` variable on FIRST call
//       — if anything read config.cashierPrinter even once before loadEnv()
//       ran, that first (empty) value was locked in forever, because
//       `if (cache) return cache` skipped recomputing it on every later
//       call. The fix below separates the two things that were wrongly
//       cached together: the FILE read (settings.json — legitimate to
//       cache, disk content doesn't change mid-session) from the ENV
//       fallback (process.env.CASHIER_PRINTER — must be read fresh every
//       time, exactly like config.http already does).

interface PersistedSettings {
  cashierPrinter?: string;
  waiterPrinter?: string;
  kitchenPrinter?: string;
  autoRetry?: boolean;
  retryCount?: number;
  /** Paired API devices. Only a SHA-256 of each token's secret is stored. */
  apiDevices?: StoredApiDevice[];
}

export interface StoredApiDevice {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt?: string;
}

let fileCache: PersistedSettings | null = null;
let settingsPath: string | null = null;

// Same app.getAppPath()-in-a-packaged-build problem as .env.local (see
// index.ts's resolveEnvPath): once packaged, app.getAppPath() resolves
// inside the read-only app.asar archive, so settings.json could never
// actually be written there — printer configuration made in the Settings UI
// would silently fail to persist. Use the writable per-OS user data
// directory once packaged, same as the encrypted auth session already does.
function getSettingsPath(): string {
  if (!settingsPath) {
    const dir = app.isPackaged ? app.getPath('userData') : app.getAppPath();
    settingsPath = join(dir, 'settings.json');
  }
  return settingsPath;
}

// Only the raw file contents are cached here — never merged with an env
// fallback. This is safe to memoize: unlike an env var that might not be
// set yet at first read, settings.json's content genuinely doesn't change
// out from under a running process except through persist() below, which
// updates this same cache directly.
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

// Outlet bound at sign-in when this machine has no OUTLET_ID configured: the
// signed-in user's own outlet. OUTLET_ID (machine config) always wins, so
// background work that must run while nobody is signed in keeps working.
let runtimeOutletId = '';

export function setRuntimeOutletId(outletId: string): void {
  runtimeOutletId = outletId;
}

export const config = {
  get http() {
    return {
      // LEGACY single shared key (x-api-key). Still accepted when set, but
      // paired devices (apiDevices) are the supported way: each phone has its
      // own revocable token. Never embedded in the build.
      apiKey: process.env.HTTP_API_KEY ?? '',
      // Optional TLS: paths to a PEM certificate and key. Set both to serve https.
      tlsCertFile: process.env.HTTPS_CERT_FILE ?? '',
      tlsKeyFile: process.env.HTTPS_KEY_FILE ?? '',
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
    return process.env.OUTLET_ID || runtimeOutletId;
  },
  // Each of these reads the ENV fallback fresh on every access (never
  // cached) and only falls back to it when settings.json has no value yet.
  // All three printer roles (Cashier/Waiter/Kitchen) live here — this file
  // is the SINGLE source of truth for printer mapping, deliberately not
  // Supabase. Printer selection is inherently a per-machine, physical-
  // hardware concern (which printer THIS specific machine's OS talks to),
  // not shared business data — it doesn't belong in a multi-tenant DB, and
  // reading it locally means it works even if Supabase is unreachable.
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
  // Devices allowed to call the local HTTP API (see apiSecurity.ts). Per-machine,
  // like the printer mapping: never embedded in a build.
  get apiDevices(): StoredApiDevice[] {
    return loadFile().apiDevices ?? [];
  },
  set apiDevices(value: StoredApiDevice[]) {
    persist({ apiDevices: value });
  },
  get autoRetry(): boolean {
    return loadFile().autoRetry ?? true;
  },
  get retryCount(): number {
    return loadFile().retryCount ?? 3;
  },
};

/**
 * Manually save/persist config to disk. No-op here since persist() now
 * writes immediately on every set — kept for backward compatibility with
 * callers that expect an explicit save step.
 */
export function saveConfig(): void {
  // Intentionally empty: cashierPrinter's setter already calls persist()
  // synchronously. This function is kept so existing callers don't break.
}
