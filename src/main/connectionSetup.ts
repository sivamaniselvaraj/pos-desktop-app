import { app, safeStorage } from 'electron';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dbBuilt, dbEnv } from './envNames';
import type { ConnectionSetupStatus, ConnectionValueSource } from '../shared/connectionTypes';

/**
 * connectionSetup.ts
 * ---------------------------------------------------------------------------
 * The three values a machine needs before it can work: the database URL
 * (DB_URL), the auth token (DB_KEY) and this machine's outlet (OUTLET_ID).
 * The old variable names (SUPABASE_URL, SUPABASE_ANON_KEY) still work; see
 * envNames.ts. They are entered on the setup screen and saved in
 * connection.json (userData once packaged, the project root in dev, the same
 * folder as settings.json). See docs/CONNECTION_SETUP.md.
 *
 * Order, first value that is set wins:
 *   1. connection.json (what was entered on the setup screen)
 *   2. process.env (OS variables or .env.local), kept for existing installs
 *   3. embeddedConfig (.env.build), URL and token only; never the outlet
 *
 * The token is encrypted with Electron safeStorage (DPAPI on Windows) when the
 * OS offers it. It is never sent to the renderer and never logged.
 * ---------------------------------------------------------------------------
 */

interface StoredConnection {
  databaseUrl?: string;
  /** "enc:<base64>" when encrypted with safeStorage, otherwise "plain:<token>". */
  authToken?: string;
  /** Names used by builds before 2026-11-09; read when the new ones are absent. */
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  outletId?: string;
  savedAt?: string;
}

interface Connection {
  databaseUrl: string;
  authToken: string;
  outletId: string;
}

let cache: Connection | null = null;
let filePath: string | null = null;

function getFilePath(): string {
  if (!filePath) {
    const dir = app.isPackaged ? app.getPath('userData') : app.getAppPath();
    filePath = join(dir, 'connection.json');
  }
  return filePath;
}

function decodeToken(stored: string | undefined): string {
  if (!stored) return '';
  if (stored.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    } catch {
      console.error('connection.json: the saved auth token could not be decrypted. Enter it again on the setup screen.');
      return '';
    }
  }
  return stored.startsWith('plain:') ? stored.slice(6) : stored;
}

function encodeToken(token: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(token).toString('base64');
  }
  return 'plain:' + token;
}

/** The saved values. Empty strings when nothing is saved. */
function saved(): Connection {
  if (cache) return cache;
  const empty = { databaseUrl: '', authToken: '', outletId: '' };
  // safeStorage can only decrypt after the app is ready (macOS keychain); don't
  // cache an early, empty read.
  if (!app.isReady()) return empty;
  try {
    const raw = JSON.parse(readFileSync(getFilePath(), 'utf8')) as StoredConnection;
    cache = {
      databaseUrl: (raw.databaseUrl ?? raw.supabaseUrl ?? '').trim(),
      authToken: decodeToken(raw.authToken ?? raw.supabaseAnonKey).trim(),
      outletId: (raw.outletId ?? '').trim(),
    };
  } catch {
    cache = empty;
  }
  return cache;
}

function pick(savedValue: string, envValue: string | undefined, buildValue: string): { value: string; source: ConnectionValueSource } {
  if (savedValue) return { value: savedValue, source: 'saved' };
  if (envValue) return { value: envValue, source: 'env' };
  if (buildValue) return { value: buildValue, source: 'build' };
  return { value: '', source: 'none' };
}

function resolveUrl() {
  return pick(saved().databaseUrl, dbEnv('DB_URL'), dbBuilt('DB_URL'));
}
function resolveToken() {
  return pick(saved().authToken, dbEnv('DB_KEY'), dbBuilt('DB_KEY'));
}
function resolveOutlet() {
  // Per machine: never from the build (see config.ts outletId).
  return pick(saved().outletId, process.env.OUTLET_ID, '');
}

/** Read fresh on every call (env is loaded after modules are imported; see config.ts). */
export const connection = {
  get databaseUrl(): string {
    return resolveUrl().value;
  },
  get authToken(): string {
    return resolveToken().value;
  },
  /** The outlet configured for this machine (saved or OUTLET_ID); '' when none. */
  get outletId(): string {
    return resolveOutlet().value;
  },
};

export function getConnectionStatus(): ConnectionSetupStatus {
  const url = resolveUrl();
  const token = resolveToken();
  const outlet = resolveOutlet();
  const missing: ConnectionSetupStatus['missing'] = [];
  if (!url.value) missing.push('databaseUrl');
  if (!token.value) missing.push('authToken');
  if (!outlet.value) missing.push('outletId');
  return {
    complete: missing.length === 0,
    missing,
    databaseUrl: url.value,
    databaseUrlSource: url.source,
    hasAuthToken: Boolean(token.value),
    authTokenSource: token.source,
    outletId: outlet.value,
    outletIdSource: outlet.source,
    filePath: getFilePath(),
    tokenEncrypted: safeStorage.isEncryptionAvailable(),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConnectionInput {
  databaseUrl: string;
  /** Empty = keep the token already in use. */
  authToken?: string;
  outletId: string;
}

/** Cleans and checks what was typed. Returns the values to use, or an error for the user. */
export function validateConnectionInput(input: ConnectionInput): { ok: true; value: Connection } | { ok: false; error: string } {
  let url = (input.databaseUrl ?? '').trim().replace(/\/+$/, '');
  if (!url) return { ok: false, error: 'Enter the database URL.' };
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol');
  } catch {
    return { ok: false, error: 'The database URL is not a valid web address (for example https://db.example.com).' };
  }
  const token = (input.authToken ?? '').trim() || resolveToken().value;
  if (!token) return { ok: false, error: 'Enter the auth token.' };
  const outletId = (input.outletId ?? '').trim();
  if (!outletId) return { ok: false, error: 'Enter the outlet id.' };
  if (!UUID_RE.test(outletId)) {
    return { ok: false, error: 'The outlet id should look like 3f2c9a1e-5b7d-4c2a-9e8f-1a2b3c4d5e6f.' };
  }
  return { ok: true, value: { databaseUrl: url, authToken: token, outletId } };
}

export function saveConnection(value: Connection): void {
  const path = getFilePath();
  const data: StoredConnection = {
    databaseUrl: value.databaseUrl,
    authToken: encodeToken(value.authToken),
    outletId: value.outletId,
    savedAt: new Date().toISOString(),
  };
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  // Write a temp file first, so a crash mid-write never leaves half a file.
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
  cache = { ...value };
  console.log(`Connection setup saved to ${path} (outlet ${value.outletId}).`);
}
