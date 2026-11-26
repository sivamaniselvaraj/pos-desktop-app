// App PIN routes: /api/pin/status, set, verify, change, lock.
// Registered after authenticate and before requireUnlock.

import type { Express } from 'express';
import { config } from '../../config';
import { deviceIdOf, devicePinHash, revokeDevice, setDevicePinHash } from '../apiSecurity';
import { checkPin, clearWrongPins, hashPin, isUnlocked, lockDevice, lockedForMs, pinFormatError, recordWrongPin, startUnlock } from '../devicePin';

/** The /api/pin/* routes. */
export function registerPinRoutes(app: Express): void {
  // ---- App PIN: the second check after the device token ----------------------
  // The token says which phone/user; the PIN (4 digits, set by the user) proves the
  // person holding it. PINs may repeat across users. Every other /api call needs the
  // X-Unlock-Token returned by /api/pin/verify (see requireUnlock).
  app.get('/api/pin/status', (req, res) => {
    const id = deviceIdOf(res);
    res.json({
      pinSet: !!devicePinHash(id),
      unlocked: isUnlocked(id, req.header('x-unlock-token') ?? ''),
      required: config.http.requirePin,
    });
  });

  // First-time PIN (only while none is set). Unlocks at once.
  app.post('/api/pin/set', (req, res) => {
    const id = deviceIdOf(res);
    if (devicePinHash(id)) return res.status(409).json({ error: 'A PIN is already set. Use change.', code: 'PIN_ALREADY_SET' });
    const pin = req.body?.pin;
    const bad = pinFormatError(pin);
    if (bad) return res.status(400).json({ error: bad, code: 'PIN_WEAK' });
    try {
      setDevicePinHash(id, hashPin(pin));
      clearWrongPins(id);
      res.json({ ok: true, ...startUnlock(id) });
    } catch {
      res.status(404).json({ error: 'Device not found.' });
    }
  });

  // Checks the PIN. Wrong tries are counted per device: 5 in a row lock it for
  // 5 minutes, 15 revoke the device (the user must pair again).
  app.post('/api/pin/verify', (req, res) => {
    const id = deviceIdOf(res);
    const stored = devicePinHash(id);
    if (!stored) return res.status(423).json({ error: 'Set an app PIN first.', code: 'PIN_NOT_SET' });
    const wait = lockedForMs(id);
    if (wait > 0) {
      res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
      return res.status(429).json({ error: 'Too many wrong PINs. Try again later.', code: 'LOCKED_OUT', retryAfterSeconds: Math.ceil(wait / 1000) });
    }
    const pin = req.body?.pin;
    if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'The PIN must be exactly 4 digits.' });
    if (checkPin(pin, stored)) {
      clearWrongPins(id);
      return res.json({ ok: true, ...startUnlock(id) });
    }
    const r = recordWrongPin(id);
    if (r.revoke) {
      revokeDevice(id);
      return res.status(401).json({ error: 'Too many wrong PINs. This phone was signed out; pair it again.', code: 'DEVICE_REVOKED' });
    }
    if (r.lockedForMs > 0) res.setHeader('Retry-After', String(Math.ceil(r.lockedForMs / 1000)));
    res.status(r.lockedForMs > 0 ? 429 : 403).json({
      error: 'Wrong PIN.',
      code: r.lockedForMs > 0 ? 'LOCKED_OUT' : 'WRONG_PIN',
      attemptsLeft: r.attemptsLeft,
      retryAfterSeconds: Math.ceil(r.lockedForMs / 1000),
    });
  });

  // Change the PIN: needs the current one. Counts wrong tries like verify.
  app.post('/api/pin/change', (req, res) => {
    const id = deviceIdOf(res);
    const stored = devicePinHash(id);
    if (!stored) return res.status(423).json({ error: 'Set an app PIN first.', code: 'PIN_NOT_SET' });
    const wait = lockedForMs(id);
    if (wait > 0) {
      res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
      return res.status(429).json({ error: 'Too many wrong PINs. Try again later.', code: 'LOCKED_OUT', retryAfterSeconds: Math.ceil(wait / 1000) });
    }
    const { pin, newPin } = req.body ?? {};
    if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'The current PIN must be exactly 4 digits.' });
    const bad = pinFormatError(newPin);
    if (bad) return res.status(400).json({ error: bad, code: 'PIN_WEAK' });
    if (!checkPin(pin, stored)) {
      const r = recordWrongPin(id);
      if (r.revoke) {
        revokeDevice(id);
        return res.status(401).json({ error: 'Too many wrong PINs. This phone was signed out; pair it again.', code: 'DEVICE_REVOKED' });
      }
      return res.status(r.lockedForMs > 0 ? 429 : 403).json({ error: 'Wrong PIN.', code: r.lockedForMs > 0 ? 'LOCKED_OUT' : 'WRONG_PIN', attemptsLeft: r.attemptsLeft });
    }
    setDevicePinHash(id, hashPin(newPin));
    clearWrongPins(id);
    res.json({ ok: true, ...startUnlock(id) });
  });

  // Lock now (the app went to the background, or the user tapped Lock).
  app.post('/api/pin/lock', (_req, res) => {
    lockDevice(deviceIdOf(res));
    res.json({ ok: true });
  });
}
