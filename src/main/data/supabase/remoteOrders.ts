import { getAuthedClient } from './sessionClient';
import type { RemoteOrderRepository } from '../ports';
import { phoneSnapshot, type OrderWatchSnapshot } from '../../kotNotifierCore';
import { OrderItem } from '../../../shared/types';

function toJsonItems(items: OrderItem[]) {
  return items.map((i) => ({
    menu_item_id: i.menuItemId,
    unit_price: i.unitPrice,
    total_price: i.totalPrice,
    quantity: i.quantity,
    note: String(i.notes),
  }));
}

async function rpcJson(fn: string): Promise<unknown> {
  const { data, error } = await getAuthedClient().rpc(fn);
  if (error) throw new Error(error.message);
  return data;
}

/** The function is not in the database yet (an older database). */
function missingFunction(error: { code?: string; message?: string }, name: string): boolean {
  return (
    error.code === 'PGRST202' ||
    error.code === '42883' ||
    new RegExp(`${name}.*(not find|does not exist)|(not find|does not exist).*${name}`, 'i').test(
      error.message ?? '',
    )
  );
}

/** get_order_watch and get_phone_orders answer the same shape. */
function parseWatch(data: unknown, allOrders: boolean): OrderWatchSnapshot {
  const d = (data ?? {}) as Record<string, unknown>;
  const arr = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
  return {
    allOrders,
    steps: arr(d.steps).map((s) => ({
      code: String(s.code),
      name: String(s.name),
      notifyWaiter: s.notify_waiter === true,
      sortOrder: Number(s.sort_order ?? 0),
    })),
    levels: arr(d.levels).map((l) => ({
      name: String(l.name),
      fromMinutes: Number(l.from_minutes ?? 0),
      notify: l.notify === true,
    })),
    orders: arr(d.orders)
      .filter((o) => allOrders || o.device_id)
      .map((o) => ({
        orderId: String(o.order_id),
        orderNumber: Number(o.order_number ?? 0),
        deviceId: o.device_id ? String(o.device_id) : null,
        tableNumber: o.table_number == null ? null : String(o.table_number),
        orderType: String(o.order_type ?? ''),
        status: String(o.status ?? ''),
        statuses: Object.fromEntries(
          Object.entries((o.statuses ?? {}) as Record<string, unknown>).map(([k, v]) => [
            k,
            Number(v),
          ]),
        ),
        since: o.since ? String(o.since) : null,
      })),
  };
}

export const remoteOrders: RemoteOrderRepository = {
  async placeOrderAs(p) {
    const { data, error } = await getAuthedClient().rpc('place_order', {
      p_actor: p.waiterId,
      p_order_type: p.orderType,
      p_table_id: p.tableId,
      p_outlet_id: p.outletId,
      p_items: toJsonItems(p.items),//p.items.map((i) => ({ menu_item_id: i.menuItemId, quantity: i.quantity })),
      p_customer_name: p.customerName ?? null,
      p_customer_phone: p.customerPhone ?? null,
      p_notes: p.notes ?? null,
      p_device_name: p.deviceName,
      p_request_id: p.clientRequestId,
      p_device_id: p.deviceId,
    });

    if (error) throw new Error(error.message);
    // return String(data);
    const d = (data ?? {}) as { order_id?: string; order_number?: number; invoice_number?: string, duplicate?: boolean };
    if (!d.order_id) throw new Error('The order was not created.');
    return { orderId: String(d.order_id), orderNumber: Number(d.order_number ?? 0), invoiceNumber: String(d.invoice_number), duplicate: d.duplicate === true };
  },
  async listPhoneOrders() {
    const w = parseWatch(await rpcJson('get_phone_orders'), false);
    return phoneSnapshot(w);
  },
  async listOrderWatch() {
    const { data, error } = await getAuthedClient().rpc('get_order_watch');
    if (error) {
      // Database without db/migrations/order_watch.sql: phone orders only, as before.
      if (missingFunction(error, 'get_order_watch'))
        return parseWatch(await rpcJson('get_phone_orders'), false);
      throw new Error(error.message);
    }
    return parseWatch(data, true);
  },
  async listMyOrders(waiterId) {
    const { data, error } = await getAuthedClient().rpc('get_my_orders', { p_waiter_id: waiterId });
    if (error) throw new Error(error.message);
    const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
    const str = (v: unknown): string | null => (v == null ? null : String(v));
    return rows.map((o) => ({
      orderId: String(o.order_id),
      orderNumber: Number(o.order_number ?? 0),
      tableId: str(o.table_id),
      tableNumber: str(o.table_number),
      floor: str(o.floor),
      outlet: String(o.outlet ?? ''),
      status: String(o.status ?? ''),
      total: Number(o.total ?? 0),
      orderType: String(o.order_type ?? ''),
      createdAt: str(o.created_at),
      notes: str(o.notes),
      items: (Array.isArray(o.items) ? (o.items as Record<string, unknown>[]) : []).map((i) => ({
        id: String(i.id),
        name: String(i.name ?? ''),
        quantity: Number(i.quantity ?? 0),
        status: String(i.status ?? ''),
        note: str(i.note),
      })),
    }));
  },
  async markItemServed(p) {
    const { data, error } = await getAuthedClient().rpc('mark_item_served', {
      p_order_id: p.orderId,
      p_item_id: p.itemId,
      p_waiter_id: p.waiterId,
    });
    if (error) throw new Error(error.message);
    const d = (data ?? {}) as { already?: boolean; from_status?: string };
    return { already: d.already === true, fromStatus: String(d.from_status ?? '') };
  },
  async getKotSettings(waiterId) {
    const { data, error } = await getAuthedClient().rpc('get_kot_settings',{
            p_waiter_id: waiterId,
        })
    if (error) throw new Error(error.message);
    const d = (data ?? {}) as Record<string, unknown>;
    const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
    return {
      serverTime: String(d.now ?? new Date().toISOString()),
      levels: arr(d.levels).map((l) => ({
        name: String(l.name),
        fromMinutes: Number(l.from_minutes ?? 0),
        color: String(l.color ?? ''),
        notify: l.notify === true,
      })),
      steps: arr(d.steps).map((s) => ({
        code: String(s.code),
        name: String(s.name),
        color: String(s.color ?? ''),
        sortOrder: Number(s.sort_order ?? 0),
        isFinal: s.is_final === true,
        notifyWaiter: s.notify_waiter === true,
      })),
    };
  },
};
