import { getAuthedClient } from './sessionClient';
import type { NewOrderLine, OrderEntryRepository } from '../ports';
import type { TaxRates } from '../../../shared/types';

function toJsonItems(items: NewOrderLine[]) {
  return items.map((i) => ({
    menu_item_id: i.menuItemId,
    unit_price: i.unitPrice,
    total_price: i.totalPrice,
    quantity: i.quantity,
  }));
}

export const orderEntry: OrderEntryRepository = {
  async getTaxRates() {
    const { data, error } = await getAuthedClient().rpc('effective_tax_rates');
    if (error) throw new Error(error.message);
    const out: TaxRates = { defaultRate: { name: 'GST', ratePercent: 0, configured: false }, byCategory: {} };
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const rate = { name: String(r.tax_name || 'GST'), ratePercent: Number(r.rate ?? 0) };
      if (r.category_id) out.byCategory[String(r.category_id)] = rate;
      else out.defaultRate = { ...rate, configured: r.configured === true };
    }
    return out;
  },

  async placeDineInOrder(a) {
    const { data, error } = await getAuthedClient().rpc('place_order', {
      p_table_id: a.tableId,
      p_items: toJsonItems(a.items),
      p_subtotal: a.subtotal,
      p_tax: a.tax,
      p_total: a.total,
      p_outlet_id: a.outletId,
    });
    if (error) throw new Error(error.message);
    return String(data);
  },

  async placePickupOrder(a) {
    const { data, error } = await getAuthedClient().rpc('place_pickup_order', {
      p_items: toJsonItems(a.items),
      p_subtotal: a.subtotal,
      p_tax: a.tax,
      p_container_charge: a.containerCharge,
      p_total: a.total,
      p_customer_name: a.customerName,
      p_customer_phone: a.customerPhone,
      p_notes: a.notes,
      p_outlet_id: a.outletId,
    });
    if (error) throw new Error(error.message);
    return String(data);
  },

  async getOrderSummary(orderId) {
    try {
      const { data } = await getAuthedClient()
        .from('orders')
        .select('order_number, invoice_number')
        .eq('id', orderId)
        .single();
      if (!data) return {};
      return {
        orderNumber: data.order_number != null ? Number(data.order_number) : undefined,
        invoiceNumber: data.invoice_number ? String(data.invoice_number) : undefined,
      };
    } catch {
      return {};
    }
  },
};
