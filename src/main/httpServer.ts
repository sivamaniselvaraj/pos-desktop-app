import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import type { Server } from 'http';
import { config } from './config';
import { orderManager } from './orderManager';
import { isDatabaseReachable } from './supabaseClient';
import { fetchOrderById } from './supabaseClient';
import type { PrintOrderRequest } from '../shared/types';

let server: Server | null = null;

export function startHttpServer(): Promise<void> {

  const app = express();
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
  app.use(express.json());

  // Define the rate limit configuration
const machineLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes window
  max: 100, // Limit each IP to 100 requests per window
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: { error: 'Too many requests, please try again later.' }
});


  // Health check
  app.get('/api/health', async (_req, res) => {
   const database = (await isDatabaseReachable()) ? 'connected' : 'disconnected';
   console.log("health check")
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      database
    });
  });


  // Main endpoint: Android posts { orderId }, we fetch + print.
  app.post('/api/print-order', machineLimiter, async (req, res) => {
    const body = req.body as PrintOrderRequest;
    if (!body?.orderId) {
      return res.status(400).json({
        success: false,
        orderId: '',
        message: 'Missing orderId in request body',
        printStatus: 'failed',
        error: 'BAD_REQUEST',
      });
    }
    const type = body.type ?? 'bill';

     console.log("printing for the order " , body.orderId, "TYPE - ", type);
    if (type !== 'bill' && type !== 'kot' && type !== 'settle') {
      return res.status(400).json({
        success: false,
        orderId: body.orderId,
        message: `Invalid type "${type}". Expected "bill", "kot", or "settle".`,
        printStatus: 'failed',
        error: 'BAD_REQUEST',
      });
    }
    try {
      const result = await orderManager.handleIncoming(body.orderId, type);
      res.status(result.success ? 200 : 502).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({
        success: false,
        orderId: body.orderId,
        message,
        printStatus: 'failed',
        error: 'SERVER_ERROR',
      });
    }
  });

  // Debug: fetch an order without printing.
  app.get('/api/order/:orderId', async (req, res) => {
    try {
      const order = await fetchOrderById(req.params.orderId);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      res.json(order);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  return new Promise((resolve, reject) => {
    server = app
      .listen(config.http.port, config.http.host, () => {
        console.log(`HTTP server listening on ${config.http.host}:${config.http.port}`);
        resolve();
      })
      .on('error', reject);
  });
}

export function stopHttpServer(): void {
  server?.close();
  server = null;
}

export function isServerRunning(): boolean {
  return server !== null;
}
