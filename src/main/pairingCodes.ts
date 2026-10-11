import { randomInt, timingSafeEqual } from 'crypto';
import type { PairingCode } from '../shared/types';

/**
 * pairingCodes.ts: the one-time 6-digit code for pairing a phone.
 *
 * Only one code is active at a time (a new one replaces the old). It lives in
 * memory only, so a restart cancels it. It works once, for 5 minutes, and is
 * cancelled after 5 wrong guesses (counted across ALL clients, so spreading
 * guesses over several addresses does not help).
 */
const TTL_MS = 5 * 60_000;
const MAX_WRONG = 5;

interface Active {
  code: string;
  expiresAt: number;
  wrong: number;
}
let active: Active | null = null;

export function createCode(now = Date.now()): PairingCode {
  active = { code: String(randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: now + TTL_MS, wrong: 0 };
  return { code: active.code, expiresAt: new Date(active.expiresAt).toISOString() };
}

export function cancelCode(): void {
  active = null;
}

export type CodeCheck = 'ok' | 'wrong' | 'gone';

/** Checks a code the phone sent. 'ok' does NOT consume it: call consumeCode() once pairing succeeded. */
export function checkCode(given: string, now = Date.now()): CodeCheck {
  if (!active || active.expiresAt <= now) {
    active = null;
    return 'gone';
  }
  const a = Buffer.from(given.padEnd(6, ' ').slice(0, 6));
  const b = Buffer.from(active.code);
  if (given.length === 6 && timingSafeEqual(a, b)) return 'ok';
  active.wrong += 1;
  if (active.wrong >= MAX_WRONG) active = null;
  return 'wrong';
}

export function consumeCode(): void {
  active = null;
}
