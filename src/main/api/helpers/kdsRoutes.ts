// Kitchen display (KDS) routes: /api/kot/board, /api/kot/move, /api/kot/move-items (docs/KDS_BOARD.md).

import type { Express } from 'express';
import { createHash } from 'crypto';
import { getKotBoard, moveKot } from '../../kotManager';
import { deviceUserId } from '../apiSecurity';
import { tablesError, UUID } from './routeHelpers';

/** The /api/kot/* routes. */
export function registerKdsRoutes(app: Express): void {
  // ---- Kitchen display (KDS) -------------------------------------------------
  // The same board and moves as the desktop KDS board, for a kitchen screen paired
  // like a phone. The device's user needs kot.view / kot.move (checked in the
  // database), and the move is logged as that user.
  //
  // GET  /api/kot/board  -> { serverTime, statuses, transitions, levels, kots }
  //   Poll every 2-5 s with If-None-Match: an unchanged board answers 304.
  // POST /api/kot/move   -> { orderId, fromStatusId, toStatusId }  (every dish of the order in that step)
  // POST /api/kot/move-items -> { orderId, itemIds, fromStatusId, toStatusId }  (only those dishes)
  app.get('/api/kot/board', async (req, res) => {
    const userId = deviceUserId(res);
    if (!userId) return res.status(403).json({ error: 'This device is not tied to a user. Pair it again.' });
    try {
      const b = await getKotBoard(userId);
      const { now, ...rest } = b;
      const etag = '"' + createHash('sha1').update(JSON.stringify(rest)).digest('hex').slice(0, 20) + '"';
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'no-cache');
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.json({ serverTime: now, ...rest });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (/^Not allowed/.test(msg)) return res.status(403).json({ error: msg });
      tablesError(err, res);
    }
  });

  app.post('/api/kot/move', async (req, res) => {
    const b = (req.body ?? {}) as { orderId?: unknown; fromStatusId?: unknown; toStatusId?: unknown };
    const { orderId, fromStatusId, toStatusId } = b;
    if (![orderId, fromStatusId, toStatusId].every((v) => typeof v === 'string' && UUID.test(v))) {
      return res.status(400).json({ error: 'orderId, fromStatusId and toStatusId must be ids' });
    }
    const userId = deviceUserId(res);
    if (!userId) return res.status(403).json({ error: 'This device is not tied to a user. Pair it again.' });
    try {
      await moveKot(orderId as string, toStatusId as string, fromStatusId as string, userId);
      res.json({ ok: true, orderId, fromStatusId, toStatusId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (/^Not allowed/.test(msg)) return res.status(403).json({ error: msg });
      if (/just moved|not allowed|Unknown step/i.test(msg)) return res.status(409).json({ error: msg });
      tablesError(err, res);
    }
  });
}
