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
import {
  auditLog,
  authenticate,
  hasValidToken,
  isOrderNumber,
  isSafeId,
  isTableNumber,
  publicMenuItem,
  rateLimit,
  securityHeaders,
} from './apiSecurity';
import type { PrintOrderRequest, PrintOrderResponse } from '../../shared/types';

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
  app.use('/api', authenticate);
  app.use('/api', express.json({ limit: '16kb' }));

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
          orderNumbers = await db.orders.fetchTableOrderNumbers(tableNumber, outletId)
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
      task: () => Promise<import('../../shared/types').PrintOrderResponse>,
      res: import('express').Response,
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
      if (config.apiDevices.length === 0 && !config.http.apiKey) {
        console.warn('No device is paired: every /api call except /api/health is refused. Pair a phone in Settings.');
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
      server.on('error', reject);
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
