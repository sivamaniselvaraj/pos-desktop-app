import { getAuthedClient } from './sessionClient';
import type { NewOrderLine, RemoteOrderRepository } from '../ports';
import { OrderItem } from '../../../shared/types';

function toJsonItems(items: OrderItem[]) {
  return items.map((i) => ({
    menu_item_id: i.menuItemId,
    unit_price: i.unitPrice,
    total_price: i.totalPrice,
    quantity: i.quantity,
  }));
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
    const { data, error } = await getAuthedClient().rpc('get_phone_orders');
    if (error) throw new Error(error.message);
    const d = (data ?? {}) as Record<string, unknown>;
    const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
    return {
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
        .filter((o) => o.device_id)
        .map((o) => ({
          orderId: String(o.order_id),
          orderNumber: Number(o.order_number ?? 0),
          deviceId: String(o.device_id),
          tableNumber: o.table_number == null ? null : String(o.table_number),
          orderType: String(o.order_type ?? ''),
          status: String(o.status ?? ''),
          statuses: Object.fromEntries(
            Object.entries((o.statuses ?? {}) as Record<string, unknown>).map(([k, v]) => [k, Number(v)]),
          ),
          since: o.since ? String(o.since) : null,
        })),
    };
  },
  async getKotSettings() {
    const { data, error } = await getAuthedClient().rpc('get_kot_settings');
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
