import express from 'express';
import cors from 'cors';
import https from 'https';
import { readFileSync } from 'fs';
import type { Server } from 'http';
import { config } from '../config';
import { orderManager } from '../orderManager';
import { printQueue } from '../printQueue';
import { db } from '../data';
import { getCachedMenuItems } from '../menuCache';
import { checkCode, consumeCode, describeCodeState, noteFailedSignIn } from './pairingCodes';
import { openStream, since as notificationsSince, startNotificationHub } from '../notificationHub';
import {
  BadRemoteOrder,
  getPhoneConfig,
  getTablesForPhones,
  getMyOrders,
  markItemServed,
  getKotSettingsForPhones,
  placeRemoteOrder,
  validateRemoteOrder,
} from '../remoteOrderManager';
import {
  auditLog,
  addPairedDevice,
  authenticate,
  deviceName,
  deviceUserId,
  hasValidToken,
  isOrderNumber,
  isSafeId,
  isTableNumber,
  publicMenuItem,
  rateLimit,
  recordAuthFailure,
  startOwnerRecheck,
  revokeDevice,
  deviceIdOf,
  securityHeaders,
  devicePinHash,
  setDevicePinHash,
  requireUnlock,
} from './apiSecurity';
import {
  checkPin,
  clearWrongPins,
  hashPin,
  isUnlocked,
  lockDevice,
  lockedForMs,
  pinFormatError,
  recordWrongPin,
  startUnlock,
} from './devicePin';
import type { DeviceOwner, PrintOrderRequest, PrintOrderResponse } from '../../shared/types';

let server: Server | https.Server | null = null;

function fail(
  res: express.Response,
  status: number,
  error: PrintOrderResponse['error'],
  message: string,
  orderId = '',
): void {
  res.status(status).json({ success: false, orderId, message, printStatus: 'failed', error });
}

export function startHttpServer(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');

  // Order matters: headers and audit first, then CORS, then rate limiting, and
  // authentication BEFORE any request body is read.
  app.use(securityHeaders);
  app.use('/api', auditLog);

  // CORS: deny cross-origin BROWSER access by default; only origins listed in
  // ALLOWED_ORIGINS are permitted. Requests with no Origin header (Android's
  // HTTP client, curl, Postman) are never subject to CORS at all — this only
  // gates a web page's fetch()/XHR, so it's safe to leave restrictive without
  // affecting the Android integration this server exists for.
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true); // non-browser client — not a CORS request
        if (config.http.allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error(`Origin not allowed by CORS: ${origin}`));
      },
    }),
  );

  app.use('/api', rateLimit);

  // Health is open so a phone can show "server reachable" before it is paired.
  // It reveals the database state only to a caller holding a valid token.
  app.get('/api/health', async (req, res) => {
    const body: Record<string, unknown> = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
    };
    if (hasValidToken(req)) {
      body.database = (await db.orders.isReachable()) ? 'connected' : 'disconnected';
    }
    res.json(body);
  });

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

  app.use('/api', authenticate);
  app.use('/api', express.json({ limit: '24kb' }));


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
  
    app.use('/api', requireUnlock);

  // ---------------------------------------------------------------------------
  // POST /api/print-order
  // KOT/plain-bill prints key on { orderId }. 'settle' is keyed by orderType:
  //   - 'dine-in'  + tableNumber -> every order in that table's batch
  //   - 'takeaway' + orderNumber -> that one order, settled standalone
  // A legacy { orderId } settle request (no orderType) still works.
  // Every order is checked to belong to THIS machine's outlet before anything
  // prints; an order of another outlet is reported as not found.
  // ---------------------------------------------------------------------------
  app.post('/api/print-order', async (req, res) => {
    const body = (req.body ?? {}) as PrintOrderRequest;
    if (typeof body !== 'object' || Array.isArray(body)) {
      return fail(res, 400, 'BAD_REQUEST', 'Request body must be a JSON object.');
    }
    const type = body.type ?? 'bill';
    if (type !== 'bill' && type !== 'kot' && type !== 'settle') {
      return fail(res, 400, 'BAD_REQUEST', 'Invalid type. Expected "bill", "kot", or "settle".');
    }
    if (body.orderId !== undefined && !isSafeId(body.orderId)) {
      return fail(res, 400, 'BAD_REQUEST', 'Invalid orderId.');
    }
    
    if (!body?.orderNumber) {
      return fail(res, 400, 'BAD_REQUEST', 'Missing orderNumber in request body.');
    }
    if (body.orderType !== 'dine_in' && body.orderType !== 'takeaway') {
        return fail(res, 400, 'BAD_REQUEST', 'Invalid orderType. Expected "dine-in" or "takeaway".');
    }

    const outletId = config.outletId;
    if (!outletId) {
      return fail(res, 503, 'SERVER_ERROR', 'This machine has no outlet configured.');
    }
    try {
     if (body.orderType === 'dine_in' && body.type === 'kot') {
      if (body.orderId == null || body.orderId === '') {
           return fail(
            res,
            400,
            'BAD_REQUEST',
            'Provide orderType + tableNumber/orderNumber, or a legacy orderId, for a settle print.',
          );
        }
        if (!(await db.orders.isOrderInOutlet(body.orderId, outletId))) {
          return fail(res, 404, 'NOT_FOUND', 'Order not found', body.orderId);
        }
      const orderId = body.orderId;
      return await runQueued(
          () => orderManager.handleIncoming(orderId, 'kot'),
          res,
        );
      
     }

      else if (body.orderType === 'dine_in') {
        //dine-in
        if (body.tableNumber == null || body.tableNumber === '') {
          return fail(res, 400, 'BAD_REQUEST', 'tableNumber is required when orderType is "dine-in".');
        }
        if (!isTableNumber(body.tableNumber)) {
          return fail(res, 400, 'BAD_REQUEST', 'Invalid tableNumber.');
        }
        const tableNumber = String(body.tableNumber);
        let orderNumbers: number[] | null;
        try {
          orderNumbers = await db.orders.fetchTableOrderNumbers(tableNumber, outletId);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          return fail(res, 500, 'SERVER_ERROR', 'failed');
        }
        if (orderNumbers === null) {
          return fail(res, 404, 'NOT_FOUND', `Table ${tableNumber} not found`);
        }
        if (orderNumbers.length === 0) {
          return fail(res, 404, 'NOT_FOUND', `Nothing outstanding to settle for table ${tableNumber}`);
        }
        return await runQueued(
          () => orderManager.handleSettleByNumbers(orderNumbers as number[], outletId),
          res,
        );
      } //end of dine-in
      else {
      // takeaway
      if (body.orderNumber == null) {
        return fail(res, 400, 'BAD_REQUEST', 'orderNumber is required when orderType is "takeaway".');
      }
      if (!isOrderNumber(body.orderNumber)) {
        return fail(res, 400, 'BAD_REQUEST', 'Invalid orderNumber.');
      }
      const orderNumber = body.orderNumber;
      return await runQueued(
        () => orderManager.handleSettleByNumbers([orderNumber], outletId),
        res
      );
      }
    } catch (err) {
      console.error('[api] print-order failed:', err);
      return fail(res, 500, 'SERVER_ERROR', 'The server could not process the request.');
    }
      // end of takeaway
  });
  async function runQueued(
      task: () => Promise<PrintOrderResponse>,
      res: express.Response,
    ): Promise<void> {
      try {
        // Every incoming print request is queued and processed strictly one
        // at a time — see printQueue.ts. This request's HTTP response still
        // waits for its own turn to run and complete; it just can't overlap
        // with another request's printer I/O while it's in the queue.
        const result = await printQueue.enqueue(task);
        res.status(result.success ? 200 : 502).json(result);
      } catch (err) {
      console.error('[api] queued print failed:', err);
      fail(res, 500, 'SERVER_ERROR', 'The server could not process the request.');
      }
    }

  // Debug: fetch an order without printing.
  app.get('/api/order/:orderId', async (req, res) => {
    const { orderId } = req.params;
    if (!isSafeId(orderId)) return res.status(400).json({ error: 'Invalid orderId' });
    if (!config.outletId) return res.status(503).json({ error: 'This machine has no outlet configured.' });
    try {
      if (!(await db.orders.isOrderInOutlet(orderId, config.outletId))) {
        return res.status(404).json({ error: 'Order not found' });
      }
      const order = await db.orders.fetchOrderById(orderId);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      res.json(order);
    } catch (err) {
      console.error('[api] order lookup failed:', err);
      res.status(500).json({ error: 'The server could not process the request.' });
    }
  });

  // Menu, served from the in-memory cache (menuCache.ts) — no database call
  // happens on this request path. Items may be stale if the last background
  // refresh failed; lastRefreshedAt/lastError let the phone show "menu may be
  // outdated". Private columns (cost price) are removed before sending.
  // ---- Remote ordering: what a phone does through the desktop ----------------
  // Sign out: this phone's token stops working at once. The phone deletes it too.
  app.post('/api/signout', (_req, res) => {
    try {
      revokeDevice(deviceIdOf(res));
      res.json({ ok: true });
    } catch {
      res.status(404).json({ error: 'Device not found.' });
    }
  });

  app.get('/api/me', async (_req, res) => {
    try {
      res.json({ device: deviceName(res), userId: deviceUserId(res), ...(await getPhoneConfig()) });
    } catch (err) {
      console.error('[api] me failed:', err);
      res.status(500).json({ error: 'The server could not process the request.' });
    }
  });

  // The signed-in waiter's own unsettled orders (not completed, not cancelled), with
  // items. The waiter is the user the phone is paired to; it cannot be chosen by the caller.
  app.get('/api/orders/mine', async (_req, res) => {
    const waiterId = deviceUserId(res);
    if (!waiterId) return res.status(403).json({ error: 'This phone is not signed in as a user.' });
    try {
      const orders = await getMyOrders(waiterId);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ waiterId, count: orders.length, orders });
    } catch (err) {
      tablesError(err, res);
    }
  });

  // Mark one item served. Only the waiter who placed the order can do it, and only
  // while the order is open. Repeating the call is safe ({ already: true }).
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  app.post('/api/orders/:orderId/items/:itemId/served', async (req, res) => {
    const { orderId, itemId } = req.params;
    if (!UUID.test(orderId) || !UUID.test(itemId)) return res.status(400).json({ error: 'Invalid orderId or itemId' });
    const waiterId = deviceUserId(res);
    if (!waiterId) return res.status(403).json({ error: 'This phone is not signed in as a user.' });
    try {
      const r = await markItemServed(waiterId, orderId, itemId);
      res.json({ ok: true, orderId, itemId, status: 'served', already: r.already });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (/Order not found|Item not found/i.test(msg)) return res.status(404).json({ error: msg });
      if (/already (completed|cancelled)|cancelled item|not marked this item ready/i.test(msg)) return res.status(409).json({ error: msg });
      tablesError(err, res);
    }
  });

  // Tables with status and details. Filters: ?status=available|occupied|reserved|cleaning
  // and ?floor=<name>. Supports ETag / If-None-Match.
  const tablesError = (err: unknown, res: express.Response): void => {
    console.error('[api] tables failed:', err);
    if (/JWT|Not authenticated|not signed in|session/i.test(err instanceof Error ? err.message : '')) {
      res.status(503).json({ error: 'The desktop app is signed out. Sign in on the desktop and try again.' });
      return;
    }
    res.status(500).json({ error: 'The server could not process the request.' });
  };

  app.get('/api/tables', async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const floor = typeof req.query.floor === 'string' ? req.query.floor.trim().toLowerCase() : '';
    if (status && !['available', 'occupied', 'reserved', 'cleaning'].includes(status)) {
      return res.status(400).json({ error: 'status must be available, occupied, reserved or cleaning' });
    }
    try {
      const all = await getTablesForPhones();
      const tables = all.filter((t) => (!status || t.status === status) && (!floor || t.floor.toLowerCase() === floor));
      const summary = { total: all.length, available: 0, occupied: 0, reserved: 0, cleaning: 0 };
      for (const t of all) summary[t.status] += 1;
      res.json({ summary, tables });
    } catch (err) {
      tablesError(err, res);
    }
  });

  app.get('/api/tables/:tableId', async (req, res) => {
    if (!isSafeId(req.params.tableId)) return res.status(400).json({ error: 'Invalid tableId' });
    try {
      const table = (await getTablesForPhones()).find((t) => t.tableId === req.params.tableId);
      if (!table) return res.status(404).json({ error: 'Table not found' });
      res.json(table);
    } catch (err) {
      tablesError(err, res);
    }
  });

  // Overdue (waiting-time) thresholds: the levels that decide when an order counts
  // as late and how it is coloured, plus the kitchen steps. Set in the KOT workflow
  // settings on the desktop.
  app.get('/api/overdue-thresholds', async (_req, res) => {
    try {
      const waiterId = deviceUserId(res);
      const s = await getKotSettingsForPhones(waiterId);
      res.json({
        serverTime: s.serverTime,
        levels: s.levels,
        steps: s.steps,
      });
    } catch (err) {
      tablesError(err, res);
    }
  });

  app.post('/api/orders', async (req, res) => {
    let body;
    try {
      body = validateRemoteOrder(req.body);
    } catch (err) {
      return res.status(400).json({ error: err instanceof BadRemoteOrder ? err.message : 'Invalid request.' });
    }
    const userId = deviceUserId(res);
    if (!userId) return res.status(403).json({ error: 'This device is not tied to a user. Pair it again.' });
    try {
      const result = await placeRemoteOrder(body, userId, deviceName(res), deviceIdOf(res));
      res.status(result.duplicate ? 200 : 201).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (/JWT|Not authenticated|not signed in|session/i.test(msg)) {
        return res.status(503).json({ error: 'The desktop app is signed out. Sign in on the desktop and try again.' });
      }
      // Rule failures from the database (item off, table not found, not allowed) are the phone user's to see.
      const ruleFailure = /not available|not allowed|cannot place|not found|at least one|Invalid/i.test(msg);
      if (!ruleFailure) console.error('[api] place order failed:', err);
      res.status(ruleFailure ? 422 : 500).json({ error: ruleFailure ? msg : 'The server could not process the request.' });
    }
  });

  // ---- Notifications for the phone that placed an order (LAN only) ----------
  // GET /api/events: a server-sent-events stream; each event is one notification.
  // GET /api/notifications?after=<id>: the same notifications as a list, for a
  // phone that cannot keep a connection open.
  app.get('/api/events', (req, res) => {
    const header = Number(req.header('Last-Event-ID'));
    const q = Number(req.query.after);
    const last = Number.isFinite(header) && header > 0 ? header : Number.isFinite(q) && q > 0 ? q : 0;
    openStream(deviceIdOf(res), res, last);
  });

  app.get('/api/notifications', (req, res) => {
    const after = Number(req.query.after);
    const items = notificationsSince(deviceIdOf(res), Number.isFinite(after) && after > 0 ? after : 0);
    res.json({ notifications: items });
  });

  app.get('/api/menu-items', (_req, res) => {
    const { items, lastRefreshedAt, lastError } = getCachedMenuItems();
    res.json({ items: items.map(publicMenuItem), lastRefreshedAt, lastError });
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // JSON parse errors and oversized bodies get a clean answer, never a stack.
  app.use(
    (
      err: { type?: string; status?: number } | undefined,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (!err) return next();
      if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
      if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
      console.error('[api] unexpected error:', err);
      res.status(err.status && err.status >= 400 && err.status < 500 ? err.status : 500).json({
        error: 'Request failed',
      });
    },
  );

  const { host, port, tlsCertFile, tlsKeyFile } = config.http;
  const useTls = Boolean(tlsCertFile && tlsKeyFile);

  return new Promise((resolve, reject) => {
    const onListening = () => {
      console.log(`HTTP${useTls ? 'S' : ''} server listening on ${host}:${port}`);
      startOwnerRecheck();
      startNotificationHub();
      if (!config.apiDevices.some((d) => d.userId) && !config.http.apiKey) {
        console.warn('No device is paired: every /api call except /api/health is refused. Pair a phone in Settings (Mobile devices).');
      }
      if (!useTls && host !== '127.0.0.1' && host !== 'localhost') {
        console.warn(
          'The API is served over plain HTTP on the network, so tokens can be read by anyone on it. ' +
            'Set HTTPS_CERT_FILE and HTTPS_KEY_FILE to serve https.',
        );
      }
      resolve();
    };
    try {
      server = useTls
        ? https
            .createServer({ cert: readFileSync(tlsCertFile), key: readFileSync(tlsKeyFile) }, app)
            .listen(port, host, onListening)
        : app.listen(port, host, onListening);
      server.on('error', (e) => {
        server = null;
        reject(e);
      });
    } catch (err) {
      reject(err);
    }
  });
}

export function stopHttpServer(): void {
  server?.close();
  server = null;
}

export function isServerRunning(): boolean {
  return server !== null;
}
