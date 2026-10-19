import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'crypto';

/**
 * devicePin.ts: the app PIN a user sets on a paired phone.
 *
 * The PIN is the second check next to the device token (fop_...): a call is allowed
 * only with BOTH the device token and a live "unlock" from a correct PIN. PINs are 4
 * digits and may repeat across users, because the token already says whose phone it is.
 *
 * Stored: only a salted scrypt hash, in the device's record. Never the PIN.
 * Unlock sessions and wrong-PIN counters live in memory only: a desktop restart locks
 * every phone again, which is the safe direction.
 */
export const UNLOCK_ABSOLUTE_MS = 12 * 60 * 60_000; // an unlock never lasts longer than a shift
export const UNLOCK_IDLE_MS = 30 * 60_000; // and ends after this long without a call
const LOCK_AFTER_WRONG = 5; // wrong PINs in a row before a short lock-out
const LOCK_MS = 5 * 60_000;
const REVOKE_AFTER_WRONG = 15; // wrong PINs in a row before the device is revoked

/** Null when the PIN is acceptable, otherwise the message to show. */
export function pinFormatError(pin: unknown): string | null {
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) return 'The PIN must be exactly 4 digits.';
  if (/^(\d)\1{3}$/.test(pin)) return 'Choose a PIN that is not four of the same digit.';
  if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) return 'Choose a PIN that is not a simple sequence like 1234.';
  return null;
}

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function checkPin(pin: string, stored: string | undefined): boolean {
  // Always do the same work, so a missing PIN and a wrong PIN take the same time.
  const parts = (stored ?? '').split('$');
  const ok = parts.length === 3 && parts[0] === 'scrypt';
  const salt = Buffer.from(ok ? parts[1] : '00'.repeat(16), 'hex');
  const expected = Buffer.from(ok ? parts[2] : '00'.repeat(32), 'hex');
  const given = scryptSync(pin, salt, 32);
  return ok && expected.length === given.length && timingSafeEqual(given, expected);
}

// ---- unlock sessions -------------------------------------------------------
interface Unlock {
  tokenHash: Buffer;
  expiresAt: number;
  lastUsed: number;
}
const unlocks = new Map<string, Unlock>();
const sha = (v: string) => createHash('sha256').update(v).digest();

export function startUnlock(deviceId: string, now = Date.now()): { unlockToken: string; expiresAt: string } {
  const unlockToken = randomBytes(24).toString('base64url');
  const expiresAt = now + UNLOCK_ABSOLUTE_MS;
  unlocks.set(deviceId, { tokenHash: sha(unlockToken), expiresAt, lastUsed: now });
  return { unlockToken, expiresAt: new Date(expiresAt).toISOString() };
}

export function isUnlocked(deviceId: string, token: string, now = Date.now()): boolean {
  const u = unlocks.get(deviceId);
  if (!u || !token) return false;
  if (u.expiresAt <= now || now - u.lastUsed > UNLOCK_IDLE_MS) {
    unlocks.delete(deviceId);
    return false;
  }
  if (!timingSafeEqual(u.tokenHash, sha(token))) return false;
  u.lastUsed = now;
  return true;
}

export function lockDevice(deviceId: string): void {
  unlocks.delete(deviceId);
}

// ---- wrong-PIN counting ----------------------------------------------------
interface Fails {
  count: number;
  lockedUntil: number;
}
const fails = new Map<string, Fails>();

/** Milliseconds this device must still wait before another PIN try; 0 when it may try. */
export function lockedForMs(deviceId: string, now = Date.now()): number {
  const f = fails.get(deviceId);
  return f && f.lockedUntil > now ? f.lockedUntil - now : 0;
}

export function recordWrongPin(
  deviceId: string,
  now = Date.now(),
): { attemptsLeft: number; lockedForMs: number; revoke: boolean } {
  const f = fails.get(deviceId) ?? { count: 0, lockedUntil: 0 };
  f.count += 1;
  const revoke = f.count >= REVOKE_AFTER_WRONG;
  if (f.count % LOCK_AFTER_WRONG === 0) f.lockedUntil = now + LOCK_MS;
  fails.set(deviceId, f);
  return {
    attemptsLeft: LOCK_AFTER_WRONG - (f.count % LOCK_AFTER_WRONG || LOCK_AFTER_WRONG),
    lockedForMs: f.lockedUntil > now ? f.lockedUntil - now : 0,
    revoke,
  };
}

export function clearWrongPins(deviceId: string): void {
  fails.delete(deviceId);
}

/** Forget everything about a device (revoked, or its PIN was reset). */
export function forgetDevice(deviceId: string): void {
  unlocks.delete(deviceId);
  fails.delete(deviceId);
}
