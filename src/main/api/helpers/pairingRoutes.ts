// Phone pairing and sign-in: POST /api/signin and POST /api/pair (docs/DEVICE_PAIRING.md).
// Registered before authenticate: these are the only calls that work without a device token.

import express from 'express';
import type { Express } from 'express';
import { config } from '../../config';
import { db } from '../../data';
import { checkCode, consumeCode, describeCodeState, noteFailedSignIn } from '../pairingCodes';
import { addPairedDevice, recordAuthFailure } from '../apiSecurity';
import type { DeviceOwner } from '../../../shared/types';

/** POST /api/signin and POST /api/pair. */
export function registerPairingRoutes(app: Express): void {
  // Everything below needs a paired device's token.
  // Pairing and sign-in are the only calls that work without one. Both prove the user
  // with the desktop's one-time code and share ONE flow (pairDevice): check the code,
  // find out who the user is, check they may use this machine, create the device.
  // They differ only in how the user is identified:
  //   /api/signin  email + password, checked by the desktop (the phone never reaches the database)
  //   /api/pair    a cloud access token the phone already holds (older flow)
  type Identify = (req: express.Request) => Promise<{ owner: DeviceOwner | null; failMessage: string }>;

  async function pairDevice(
    req: express.Request,
    res: express.Response,
    code: string,
    deviceName: string,
    identify: Identify,
  ): Promise<void> {
    const check = checkCode(code);
    if (check === 'gone') {
      console.warn(`[api] pairing refused: ${describeCodeState()}`);
      res.status(410).json({ error: 'The pairing code expired or was already used. Ask for a new one.' });
      return;
    }
    if (check === 'wrong') {
      recordAuthFailure(req);
      res.status(403).json({ error: 'Wrong pairing code.' });
      return;
    }
    const outletId = config.outletId;
    if (!outletId) {
      res.status(503).json({ error: 'This machine has no outlet configured.' });
      return;
    }

    try {
      const { owner, failMessage } = await identify(req);
      if (!owner) {
        recordAuthFailure(req);
        noteFailedSignIn(); // guessing passwords also uses up the code
        res.status(401).json({ error: failMessage });
        return;
      }
      if (!owner.isActive || owner.outletId !== outletId) {
        res.status(403).json({ error: 'This user cannot use this machine.' });
        return;
      }
      const { device, token } = addPairedDevice(deviceName, owner);
      consumeCode();
      console.log(`[api] paired device "${device.name}" for user "${owner.name}"`);
      res.json({ token, deviceId: device.id, deviceName: device.name, userId: owner.userId, userName: owner.name });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not pair.';
      // Name taken / device limit: the user can fix these, so say so.
      const userFixable = /already paired|At most/.test(msg);
      if (!userFixable) console.error('[api] pairing failed:', msg);
      if (/not reachable|not configured/i.test(msg)) {
        res.status(503).json({ error: 'The desktop cannot reach the sign-in service. Check its internet connection.' });
        return;
      }
      res.status(userFixable ? 409 : 500).json({ error: userFixable ? msg : 'The server could not process the request.' });
    }
  }

  const codeAndName = (body: { code?: unknown; deviceName?: unknown }) => ({
    code: typeof body.code === 'string' ? body.code.trim() : '',
    deviceName: typeof body.deviceName === 'string' ? body.deviceName.trim() : '',
  });
  const validCodeAndName = (v: { code: string; deviceName: string }) =>
    /^\d{6}$/.test(v.code) && v.deviceName.length >= 1 && v.deviceName.length <= 60;

  // Sign in from the phone through the desktop: email + password + the one-time code.
  app.post('/api/signin', express.json({ limit: '4kb' }), async (req, res) => {
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown; code?: unknown; deviceName?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const cn = codeAndName(body);
    if (
      !/^[^\s@]{1,64}@[^\s@]{1,255}$/.test(email) ||
      email.length > 254 ||
      password.length < 1 ||
      password.length > 200 ||
      !validCodeAndName(cn)
    ) {
      return res.status(400).json({ error: 'Send an email, a password, a 6-digit code and a device name of 1 to 60 characters.' });
    }
    await pairDevice(req, res, cn.code, cn.deviceName, async () => ({
      owner: await db.devices.signInAsUser(email, password),
      failMessage: 'Wrong email or password.',
    }));
  });
}
