// Notifications and menu for phones: GET /api/events (SSE), GET /api/notifications, GET /api/menu-items.

import type { Express } from 'express';
import { getCachedMenuItems } from '../../menuCache';
import { openStream, since as notificationsSince } from '../../notificationHub';
import { deviceIdOf, publicMenuItem } from '../apiSecurity';

/** The notification stream, the notification list and the menu. */
export function registerFeedRoutes(app: Express): void {
  // ---- Notifications for the phone that placed an order (LAN only) ----------
  // GET /api/events: a server-sent-events stream; each event is one notification.
  // With ?live=1 it also carries `changed` events ({ scopes, at }) when this
  // outlet's orders or tables change, so the phone reloads them at once
  // (docs/LIVE_UPDATES.md).
  // GET /api/notifications?after=<id>: the same notifications as a list, for a
  // phone that cannot keep a connection open.
  app.get('/api/events', (req, res) => {
    const header = Number(req.header('Last-Event-ID'));
    const q = Number(req.query.after);
    const last = Number.isFinite(header) && header > 0 ? header : Number.isFinite(q) && q > 0 ? q : 0;
    const live = req.query.live === '1' || req.query.live === 'true';
    openStream(deviceIdOf(res), res, last, live);
  });

  app.get('/api/notifications', (req, res) => {
    const after = Number(req.query.after);
    const items = notificationsSince(deviceIdOf(res), Number.isFinite(after) && after > 0 ? after : 0);
    res.json({ notifications: items });
  });

  // Menu, served from the in-memory cache (menuCache.ts) — no database call
  // happens on this request path. Items may be stale if the last background
  // refresh failed; lastRefreshedAt/lastError let the phone show "menu may be
  // outdated". Private columns (cost price) are removed before sending.
  app.get('/api/menu-items', (_req, res) => {
    const { items, lastRefreshedAt, lastError } = getCachedMenuItems();
    res.json({ items: items.map(publicMenuItem), lastRefreshedAt, lastError });
  });
}
