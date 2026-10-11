import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { config, type StoredApiDevice } from '../config';
import { db } from '../data';
import type { ApiDevice, DeviceOwner } from '../../shared/types';

/**
 * apiSecurity.ts
 * ---------------------------------------------------------------------------
 * Security for the local HTTP API that phones call (print-order, menu-items).
 *
 * - Per-device bearer tokens. Each phone is paired once from Settings and gets
 *   its own token (`fop_<id>.<secret>`), shown a single time. Only a SHA-256 of
 *   the secret is stored, so a copy of settings.json does not reveal tokens,
 *   and one lost phone is revoked without touching the others.
 * - Fail closed: with no paired device (and no legacy key) every /api call
 *   except /api/health is refused.
 * - Rate limiting per client address, and a temporary block after repeated bad
 *   credentials, so a token cannot be guessed by hammering the endpoint.
 * - Input validators for the values the handlers pass on to the database.
 *
 * Tokens are accepted as `Authorization: Bearer <token>` (preferred) or
 * `x-api-key: <token>` (older clients). The legacy single shared key from
 * HTTP_API_KEY is still accepted when set.
 * ---------------------------------------------------------------------------
 */

const TOKEN_PREFIX = 'fop_';
const MAX_DEVICES = 20;

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 120; // per client per window
const FAIL_WINDOW_MS = 10 * 60_000;
const FAIL_MAX = 10; // bad credentials per window before the client is blocked
const BLOCK_MS = 10 * 60_000;
const LAST_USED_WRITE_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Device registry
// ---------------------------------------------------------------------------
function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function toPublic(d: StoredApiDevice): ApiDevice {
  return {
    id: d.id,
    name: d.name,
    createdAt: d.createdAt,
    lastUsedAt: d.lastUsedAt,
    userName: d.userName,
    valid: !!d.userId,
  };
}

export function listDevices(): ApiDevice[] {
  return config.apiDevices.map(toPublic);
}

/** Adds a phone bound to the staff user it paired with. Returns the token, shown to the phone once. */
export function addPairedDevice(name: string, owner: DeviceOwner): { device: ApiDevice; token: string } {
  const clean = String(name ?? '').trim();
  if (clean.length < 1 || clean.length > 60) throw new Error('Device name must be 1 to 60 characters.');
  const devices = config.apiDevices;
  if (devices.length >= MAX_DEVICES) throw new Error(`At most ${MAX_DEVICES} devices can be paired. Revoke one first.`);
  if (devices.some((d) => d.name.toLowerCase() === clean.toLowerCase())) {
    throw new Error(`A device named "${clean}" is already paired.`);
  }

  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  const secret = randomBytes(32).toString('base64url');
  const stored: StoredApiDevice = {
    id,
    name: clean,
    tokenHash: sha256(secret).toString('hex'),
    createdAt: new Date().toISOString(),
    userId: owner.userId,
    userName: owner.name,
  };
  config.apiDevices = [...devices, stored];
  ownerAllowed.set(owner.userId, true);
  return { device: toPublic(stored), token: `${TOKEN_PREFIX}${id}.${secret}` };
}

// ---------------------------------------------------------------------------
// Owner re-check: a phone stops working when its user is deactivated or moves
// to another outlet. Done in the background (the request path stays
// synchronous); if the database cannot be reached the last known answer stands.
// ---------------------------------------------------------------------------
const OWNER_RECHECK_MS = 5 * 60_000;
const ownerAllowed = new Map<string, boolean>();
let recheckTimer: NodeJS.Timeout | null = null;

export async function refreshOwners(): Promise<void> {
  const ids = [...new Set(config.apiDevices.map((d) => d.userId).filter((v): v is string => !!v))];
  if (ids.length === 0) return;
  try {
    const rows = await db.devices.ownerStatus(ids);
    for (const r of rows) ownerAllowed.set(r.userId, r.isActive && r.inOutlet);
  } catch (err) {
    console.warn('[api] could not re-check paired users, keeping the last answer:', err instanceof Error ? err.message : err);
  }
}

export function startOwnerRecheck(): void {
  if (recheckTimer) return;
  void refreshOwners();
  recheckTimer = setInterval(() => void refreshOwners(), OWNER_RECHECK_MS);
  recheckTimer.unref?.();
}

export function revokeDevice(id: string): void {
  const devices = config.apiDevices;
  if (!devices.some((d) => d.id === id)) throw new Error('Device not found.');
  config.apiDevices = devices.filter((d) => d.id !== id);
}

/** Counts a bad request (for example a wrong pairing code) against the client's lockout. */
export function recordAuthFailure(req: Request): void {
  recordFailure(clientKey(req));
}

interface Identity {
  id: string;
  name: string;
  /** The staff user the device is paired to (absent only for the legacy shared key). */
  userId?: string;
}

function identify(token: string): Identity | null {
  // Legacy shared key.
  const legacy = config.http.apiKey;
  if (legacy) {
    const a = sha256(token);
    const b = sha256(legacy);
    if (timingSafeEqual(a, b)) return { id: 'legacy-key', name: 'legacy key' };
  }

  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const id = token.slice(TOKEN_PREFIX.length, dot);
  const secret = token.slice(dot + 1);
  if (!/^[a-f0-9]{12}$/.test(id) || secret.length < 20 || secret.length > 80) return null;

  const device = config.apiDevices.find((d) => d.id === id);
  // Always compute a hash so unknown ids and wrong secrets take the same time.
  const given = sha256(secret);
  const expected = device ? Buffer.from(device.tokenHash, 'hex') : sha256('no-such-device');
  const ok = timingSafeEqual(given, expected) && !!device;
  if (!ok || !device) return null;
  // Devices paired before one-time codes have no user: no longer accepted.
  if (!device.userId) return null;
  if (ownerAllowed.get(device.userId) === false) return null;

  touch(device);
  return { id: device.id, name: device.name, userId: device.userId };
}

const lastWrite = new Map<string, number>();
function touch(device: StoredApiDevice): void {
  const now = Date.now();
  if (now - (lastWrite.get(device.id) ?? 0) < LAST_USED_WRITE_MS) return;
  lastWrite.set(device.id, now);
  config.apiDevices = config.apiDevices.map((d) =>
    d.id === device.id ? { ...d, lastUsedAt: new Date(now).toISOString() } : d,
  );
}

// ---------------------------------------------------------------------------
// Rate limiting and lockout (in memory, per client address)
// ---------------------------------------------------------------------------
interface Window {
  count: number;
  resetAt: number;
}
const requests = new Map<string, Window>();
const failures = new Map<string, Window & { blockedUntil?: number }>();

function clientKey(req: Request): string {
  // Direct peer address only. X-Forwarded-For is attacker-controlled here.
  return req.socket.remoteAddress ?? 'unknown';
}

function prune(): void {
  const now = Date.now();
  for (const [k, v] of requests) if (v.resetAt <= now) requests.delete(k);
  for (const [k, v] of failures) if (v.resetAt <= now && (v.blockedUntil ?? 0) <= now) failures.delete(k);
}

function tooMany(res: Response, retryAfterMs: number): void {
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  res.status(429).json({ error: 'Too many requests. Try again later.' });
}

/** General per-client request limit. Runs before authentication. */
export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  if (requests.size > 2000) prune();
  const now = Date.now();
  const key = clientKey(req);

  const blocked = failures.get(key);
  if (blocked?.blockedUntil && blocked.blockedUntil > now) return tooMany(res, blocked.blockedUntil - now);

  let w = requests.get(key);
  if (!w || w.resetAt <= now) {
    w = { count: 0, resetAt: now + RATE_WINDOW_MS };
    requests.set(key, w);
  }
  w.count += 1;
  if (w.count > RATE_MAX_REQUESTS) return tooMany(res, w.resetAt - now);
  next();
}

function recordFailure(key: string): void {
  const now = Date.now();
  let f = failures.get(key);
  if (!f || f.resetAt <= now) {
    f = { count: 0, resetAt: now + FAIL_WINDOW_MS };
    failures.set(key, f);
  }
  f.count += 1;
  if (f.count >= FAIL_MAX) f.blockedUntil = now + BLOCK_MS;
}

// ---------------------------------------------------------------------------
// Authentication middleware
// ---------------------------------------------------------------------------
function readToken(req: Request): string {
  const auth = req.header('authorization') ?? '';
  const m = /^Bearer\s+(\S{1,200})$/i.exec(auth);
  if (m) return m[1];
  const key = req.header('x-api-key') ?? '';
  return key.length <= 200 ? key : '';
}

/** True when the request carries a valid token. No side effects on the failure counters. */
export function hasValidToken(req: Request): boolean {
  const token = readToken(req);
  return !!token && identify(token) !== null;
}

/** The staff user the authenticated device belongs to ('' for the legacy key). */
export function deviceUserId(res: Response): string {
  return String(res.locals.userId ?? '');
}

/** Id of the authenticated device. Set by `authenticate`. */
export function deviceIdOf(res: Response): string {
  return String(res.locals.deviceId ?? '');
}

/** Name of the authenticated device for the audit log. Set by `authenticate`. */
export function deviceName(res: Response): string {
  return String(res.locals.deviceName ?? '-');
}

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const token = readToken(req);
  const who = token ? identify(token) : null;
  if (!who) {
    recordFailure(clientKey(req));
    res.setHeader('WWW-Authenticate', 'Bearer');
    // The same answer whether there is no token, a bad token, or no paired device.
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.locals.deviceId = who.id;
  res.locals.deviceName = who.name;
  res.locals.userId = who.userId ?? '';
  next();
}

/** One audit line per request: who, what, result. Never the token or the body. */
export function auditLog(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();
  res.on('finish', () => {
    console.log(
      `[api] ${clientKey(req)} device="${deviceName(res)}" ${req.method} ${req.path} -> ${res.statusCode} ${Date.now() - started}ms`,
    );
  });
  next();
}

/** Headers that stop a browser or proxy from caching or sniffing API responses. */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  next();
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------
/** Ids as the database issues them (uuid or short text): letters, digits, - and _. */
export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

export function isOrderNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1_000_000_000;
}

export function isTableNumber(value: unknown): value is string | number {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 100_000;
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length >= 1 && value.length <= 32 && !/[\u0000-\u001f]/.test(value);
}

/** Columns that must never leave the machine through the menu API. */
const MENU_PRIVATE_FIELDS = ['cost_price'];

export function publicMenuItem(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...item };
  for (const f of MENU_PRIVATE_FIELDS) delete out[f];
  return out;
}
