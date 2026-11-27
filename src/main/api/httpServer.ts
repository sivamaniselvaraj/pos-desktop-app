// The phone API (Express): middleware order, the open health route, and start/stop.
// The routes themselves are in src/main/http/ (one file per area), registered below
// in the same order as before the split.
import express from 'express';
import { app as electronApp } from 'electron';
import cors from 'cors';
import https from 'https';
import { readFileSync } from 'fs';
import type { Server } from 'http';
import { config } from '../config';
import { db } from '../data';
import { isDatabaseConnected } from '../offlineManager';
import { buildHealthBody, createOutletNameCache } from '../healthInfo';
import { apiTiming } from '../apiTimingsManager';
import { startNotificationHub } from '../notificationHub';
import { auditLog, authenticate, hasValidToken, rateLimit, requireUnlock, securityHeaders, startOwnerRecheck } from './apiSecurity';
import { registerPairingRoutes } from './helpers/pairingRoutes';
import { registerPinRoutes } from './helpers/pinRoutes';
import { registerPrintRoutes } from './helpers/printRoutes';
import { registerPlaceOrderRoute, registerWaiterRoutes } from './helpers/waiterRoutes';
import { registerKdsRoutes } from './helpers/kdsRoutes';
import { registerTableRoutes } from './helpers/tableRoutes';
import { registerFeedRoutes } from './helpers/feedRoutes';

let server: Server | https.Server | null = null;

// Outlet display name for /api/health (cached: phones poll every 10 s).
const outletName = createOutletNameCache((id:any) => db.auth.loadOutletName(id));

export function startHttpServer(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');

  // Order matters: headers and audit first, then CORS, then rate limiting, and
  // authentication BEFORE any request body is read.
  app.use(securityHeaders);
  app.use('/api', auditLog);
  // Response time per route, in memory (About page > Performance monitor, docs/TIMINGS.md).
  app.use('/api', apiTiming());

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
    res.json(
      await buildHealthBody({
        appVersion: electronApp.getVersion(),
        hasValidToken: hasValidToken(req),
        isDatabaseConnected,
        restaurantName: () => outletName(config.outletId),
      }),
    );
  });

  registerPairingRoutes(app);

  app.use('/api', authenticate);
  app.use('/api', express.json({ limit: '24kb' }));

  // App PIN: the second check after the device token. Every route registered after
  // requireUnlock needs the X-Unlock-Token returned by /api/pin/verify.
  registerPinRoutes(app);
  app.use('/api', requireUnlock);

  // Same order as before the split (docs/CODE_CLEANUP.md).
  registerPrintRoutes(app);
  registerWaiterRoutes(app);
  registerKdsRoutes(app);
  registerTableRoutes(app);
  registerPlaceOrderRoute(app);
  registerFeedRoutes(app);

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
