import type { Response } from 'express';
import { db } from './data';
import { config } from './config';
import { diffStates, type Memory, type PhoneNotification } from './kotNotifierCore';
import type { LiveChange } from '../shared/liveTypes';

/**
 * notificationHub.ts: LAN-only notifications to the phone that placed an order.
 *
 * The desktop looks at the phone-placed orders every few seconds, works out
 * what changed (kotNotifierCore.diffStates) and queues each notification for
 * the device that placed that order, and only that device. A phone receives
 * them over one open connection (GET /api/events, server-sent events) or, if
 * it cannot keep one open, by asking (GET /api/notifications?after=<id>).
 * Nothing leaves the local network, and nothing is kept after the desktop app
 * closes.
 */

const POLL_MS = 5000;
const HEARTBEAT_MS = 20000;
const KEEP_PER_DEVICE = 100;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface QueuedNotification extends PhoneNotification {
  id: number;
  at: string;
}

interface Box {
  nextId: number;
  items: QueuedNotification[];
  clients: Set<Response>;
  /** Connections that asked for change events (GET /api/events?live=1). */
  liveClients: Set<Response>;
}

const boxes = new Map<string, Box>();
const memory: Memory = new Map();
let timer: NodeJS.Timeout | null = null;
let busy = false;

function box(deviceId: string): Box {
  let b = boxes.get(deviceId);
  if (!b) {
    b = { nextId: 1, items: [], clients: new Set(), liveClients: new Set() };
    boxes.set(deviceId, b);
  }
  return b;
}

function pairedIds(): Set<string> {
  return new Set(config.apiDevices.map((d) => d.id));
}

function sse(res: Response, n: QueuedNotification): void {
  res.write(`id: ${n.id}\nevent: notification\ndata: ${JSON.stringify(n)}\n\n`);
}

/** Queues a notification for its device and pushes it to the device's open connections. */
export function publish(n: PhoneNotification): void {
  if (!pairedIds().has(n.deviceId)) return;
  const b = box(n.deviceId);
  const q: QueuedNotification = { ...n, id: b.nextId++, at: new Date().toISOString() };
  b.items.push(q);
  const cutoff = Date.now() - MAX_AGE_MS;
  while (b.items.length > KEEP_PER_DEVICE || (b.items[0] && new Date(b.items[0].at).getTime() < cutoff)) b.items.shift();
  for (const c of b.clients) sse(c, q);
}

/** Notifications for a device newer than `after`. */
export function since(deviceId: string, after: number): QueuedNotification[] {
  return (boxes.get(deviceId)?.items ?? []).filter((n) => n.id > after);
}

/**
 * Tells every paired device that asked for it (GET /api/events?live=1) that
 * this outlet's orders or tables changed, so it reloads them now instead of
 * polling (docs/LIVE_UPDATES.md). The event has no id: it is not replayed and
 * does not move the phone's Last-Event-ID. Older apps that did not ask for it
 * never get it.
 */
export function broadcastChange(change: LiveChange): void {
  const line = `event: changed\ndata: ${JSON.stringify({ scopes: change.scopes, at: change.at })}\n\n`;
  for (const b of boxes.values()) for (const c of b.liveClients) c.write(line);
}

/**
 * Opens the event stream for a device. `lastId` is the Last-Event-ID the phone saw, to replay what it missed.
 * `live`: also send `changed` events (orders or tables changed).
 */
export function openStream(deviceId: string, res: Response, lastId: number, live = false): void {
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write('retry: 5000\n\n');
  const b = box(deviceId);
  for (const n of b.items) if (n.id > lastId) sse(res, n);
  b.clients.add(res);
  if (live) b.liveClients.add(res);
  res.on('close', () => {
    b.clients.delete(res);
    b.liveClients.delete(res);
  });
}

async function pollOnce(): Promise<void> {
  if (busy || !config.outletId || config.apiDevices.length === 0) return;
  busy = true;
  try {
    const snap = await db.remoteOrders.listPhoneOrders();
    for (const n of diffStates(memory, snap, new Date())) publish(n);
  } catch (err) {
    // Signed out or offline: try again next round; no notifications are lost, the state is compared next time.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/JWT|Not authenticated|not signed in|session/i.test(msg)) console.warn('[notify] could not read orders:', msg);
  } finally {
    busy = false;
  }
}

function housekeeping(): void {
  const ids = pairedIds();
  for (const [id, b] of boxes) {
    if (!ids.has(id)) {
      // A revoked device: close its connections and forget it.
      for (const c of b.clients) c.end();
      boxes.delete(id);
      continue;
    }
    for (const c of b.clients) c.write(': keep-alive\n\n');
  }
}

export function startNotificationHub(): void {
  if (timer) return;
  timer = setInterval(() => void pollOnce(), POLL_MS);
  timer.unref?.();
  const hb = setInterval(housekeeping, HEARTBEAT_MS);
  hb.unref?.();
  void pollOnce();
}
