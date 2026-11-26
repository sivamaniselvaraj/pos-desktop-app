// Waiter phone routes: sign out, /api/me, the waiter's own orders, mark served, and placing an order.

import type { Express } from 'express';
import { BadRemoteOrder, getMyOrders, getPhoneConfig, markItemServed, placeRemoteOrder, validateRemoteOrder } from '../../remoteOrderManager';
import { deviceIdOf, deviceName, deviceUserId, revokeDevice } from '../apiSecurity';
import { tablesError, UUID } from './routeHelpers';

/** POST /api/signout, GET /api/me, GET /api/orders/mine, POST /api/orders/:orderId/items/:itemId/served. */
export function registerWaiterRoutes(app: Express): void {
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
}

/** POST /api/orders: a phone places an order (registered after the table routes, as before). */
export function registerPlaceOrderRoute(app: Express): void {
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
}
