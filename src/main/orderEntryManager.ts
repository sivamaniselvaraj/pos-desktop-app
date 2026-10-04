import { getAuthedClient } from './supabaseAuthClient';
import { getCachedMenuItems } from './menuCache';
import { config } from './config';
import { computeTotals, type PricedLine } from '../shared/orderTotals';
import type { PlaceOrderPayload, PlaceOrderResult, TaxRate } from '../shared/types';
import {
  DINE_IN_ORDER_TYPE,
}from '../shared/types';

/**
 * orderEntryManager.ts
 * ---------------------------------------------------------------------------
 * Backs the New Order page. Dine-in orders go through the same place_order()
 * RPC the Android app uses; pickup orders go through place_pickup_order().
 * Prices, container percentages and the GST rate are all re-read here, and
 * the totals recomputed, so nothing the renderer displays is trusted.
 * ---------------------------------------------------------------------------
 */

export async function getTaxRate(): Promise<TaxRate> {
  const supabase = getAuthedClient();
  const { data, error } = await supabase
    .from('tax_settings')
    .select('name, rate_percent')
    .eq('outlet_id', config.outletId)
    .eq('is_active', true)
    .order('updated_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const row = (data ?? [])[0] as { name?: string; rate_percent?: number | string } | undefined;
  if (!row) return { name: 'GST', ratePercent: 0, configured: false };
  return { name: row.name || 'GST', ratePercent: Number(row.rate_percent ?? 0), configured: true };
}

export async function placeOrder(payload: PlaceOrderPayload): Promise<PlaceOrderResult> {
  if (!config.outletId) throw new Error('OUTLET_ID is not configured for this machine.');
  if (!payload.items?.length) throw new Error('Add at least one item to the order.');
  const isDineIn = payload.orderType === DINE_IN_ORDER_TYPE;
  if (isDineIn && !payload.tableId) throw new Error('Select a table for a dine-in order.');

  const menu = new Map<string, Record<string, unknown>>();
  for (const it of getCachedMenuItems().items) menu.set(String(it.id), it);

  const lines: PricedLine[] = [];
  const dbItems: { menu_item_id: string; unit_price: number; total_price: number; quantity: number }[] = [];
  for (const l of payload.items) {
    const m = menu.get(l.menuItemId);
    if (!m) throw new Error('An item in the cart is no longer on the menu. Refresh the menu and try again.');
    if (m.is_active === false || m.is_available === false) {
      throw new Error(`"${String(m.name)}" is not available right now.`);
    }
    const qty = Math.floor(Number(l.quantity));
    if (!Number.isFinite(qty) || qty < 1 || qty > 99) throw new Error(`Invalid quantity for "${String(m.name)}".`);
    const unit = Number(m.price);
    lines.push({ unitPrice: unit, quantity: qty, containerPercent: Number(m.container_charge ?? 0) || 0 });
    dbItems.push({
      menu_item_id: l.menuItemId,
      unit_price: unit,
      total_price: Math.round(unit * qty * 100) / 100,
      quantity: qty,
    });
  }

  const tax = await getTaxRate();
  const totals = computeTotals(lines, tax.ratePercent, !isDineIn);
  const supabase = getAuthedClient();

  let orderId: string;
  if (isDineIn) {
    const { data: t, error: tErr } = await supabase
      .from('tables')
      .select('state')
      .eq('id', payload.tableId as string)
      .single();
    if (tErr) throw new Error(tErr.message);
    if (t.state === 'reserved' || t.state === 'cleaning') {
      throw new Error(`This table is ${t.state}. Change its status on the Tables page first.`);
    }
    const { data, error } = await supabase.rpc('place_order', {
      p_table_id: payload.tableId,
      p_items: dbItems,
      p_subtotal: totals.subtotal,
      p_tax: totals.tax,
      p_total: totals.total,
      p_outlet_id: config.outletId,
    });
    if (error) throw new Error(error.message);
    orderId = String(data);
  } else {
    const { data, error } = await supabase.rpc('place_pickup_order', {
      p_items: dbItems,
      p_subtotal: totals.subtotal,
      p_tax: totals.tax,
      p_container_charge: totals.containerCharge,
      p_total: totals.total,
      p_customer_name: payload.customerName?.trim() || null,
      p_customer_phone: payload.customerPhone?.trim() || null,
      p_notes: payload.notes?.trim() || null,
      p_outlet_id: config.outletId,
    });
    if (error) throw new Error(error.message);
    orderId = String(data);
  }

  // Best effort: the order is already placed, so a failed lookup only means
  // the confirmation shows fewer details.
  let orderNumber: number | undefined;
  let invoiceNumber: string | undefined;
  try {
    const { data } = await supabase
      .from('orders')
      .select('order_number, invoice_number')
      .eq('id', orderId)
      .single();
    if (data) {
      orderNumber = data.order_number != null ? Number(data.order_number) : undefined;
      invoiceNumber = data.invoice_number ? String(data.invoice_number) : undefined;
    }
  } catch {
    /* ignore */
  }
  return { orderId, orderNumber, invoiceNumber, total: totals.total };
}
