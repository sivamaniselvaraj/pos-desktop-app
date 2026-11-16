import type { RemoteOrderRequest } from '../shared/types';
import { DINE_IN_ORDER_TYPE } from '../shared/types';


const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class BadRemoteOrder extends Error {}

/** Body of POST /api/tables, after validation. */
export interface NewTableRequest {
  tableNumber: string;
  floor: string | null;
  capacity: number | null;
}

/** Checks the body of POST /api/tables. Permission, outlet and duplicates are checked by the database. */
export function validateNewTable(body: unknown): NewTableRequest {
  const b = (body ?? {}) as { tableNumber?: unknown; floor?: unknown; capacity?: unknown };
  const raw = typeof b.tableNumber === 'number' && Number.isInteger(b.tableNumber) ? String(b.tableNumber) : b.tableNumber;
  const tableNumber = typeof raw === 'string' ? raw.trim() : '';
  // eslint-disable-next-line no-control-regex
  if (!tableNumber || tableNumber.length > 32 || /[\u0000-\u001f]/.test(tableNumber)) {
    throw new BadRemoteOrder('tableNumber must be text of 1 to 32 characters.');
  }
  if (b.floor !== undefined && b.floor !== null && (typeof b.floor !== 'string' || b.floor.trim().length > 64)) {
    throw new BadRemoteOrder('floor must be text of at most 64 characters.');
  }
  const floor = typeof b.floor === 'string' && b.floor.trim() ? b.floor.trim() : null;
  if (
    b.capacity !== undefined &&
    b.capacity !== null &&
    !(typeof b.capacity === 'number' && Number.isInteger(b.capacity) && b.capacity >= 1 && b.capacity <= 1000)
  ) {
    throw new BadRemoteOrder('capacity must be a whole number from 1 to 1000.');
  }
  const capacity = typeof b.capacity === 'number' ? b.capacity : null;
  return { tableNumber, floor, capacity };
}

/** Checks the request shape. Prices and availability are checked by the database. */
export function validateRemoteOrder(body: unknown): RemoteOrderRequest {
  const b = (body ?? {}) as Partial<RemoteOrderRequest>;
  //console.log(b.orderType)
  if (b.orderType !== DINE_IN_ORDER_TYPE && b.orderType !== 'takeaway') {
    throw new BadRemoteOrder('orderType must be "dine_in" or "takeaway".');
  }
  if (b.orderType === DINE_IN_ORDER_TYPE && !(typeof b.tableId === 'string' && UUID.test(b.tableId))) {
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

