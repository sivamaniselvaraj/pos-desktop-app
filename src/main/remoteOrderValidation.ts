import type { RemoteOrderRequest } from '../shared/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class BadRemoteOrder extends Error {}

/** Checks the request shape. Prices and availability are checked by the database. */
export function validateRemoteOrder(body: unknown): RemoteOrderRequest {
  const b = (body ?? {}) as Partial<RemoteOrderRequest>;
  if (b.orderType !== 'dine-in' && b.orderType !== 'takeaway') {
    throw new BadRemoteOrder('orderType must be "dine-in" or "takeaway".');
  }
  if (b.orderType === 'dine-in' && !(typeof b.tableId === 'string' && UUID.test(b.tableId))) {
    throw new BadRemoteOrder('A dine-in order needs the tableId from GET /api/tables.');
  }
  if (typeof b.clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(b.clientRequestId)) {
    throw new BadRemoteOrder('clientRequestId must be 8 to 64 letters, digits, - or _.');
  }
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 60) {
    throw new BadRemoteOrder('An order needs 1 to 60 items.');
  }
  const seen = new Set<string>();
  for (const i of b.items) {
    if (!i || typeof i.menuItemId !== 'string' || !UUID.test(i.menuItemId)) {
      throw new BadRemoteOrder('Every item needs a valid menuItemId.');
    }
    if (!Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 99) {
      throw new BadRemoteOrder('Quantity must be a whole number from 1 to 99.');
    }
    if (seen.has(i.menuItemId)) throw new BadRemoteOrder('List each item once and use its quantity.');
    seen.add(i.menuItemId);
  }
  for (const [k, max] of [['customerName', 100], ['customerPhone', 30], ['notes', 500]] as const) {
    const v = b[k];
    if (v !== undefined && (typeof v !== 'string' || v.length > max)) {
      throw new BadRemoteOrder(`${k} must be text of at most ${max} characters.`);
    }
  }
  return b as RemoteOrderRequest;
}

