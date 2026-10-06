import { db, type NewOrderLine } from './data';
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
 * Backs the New Order page. Dine-in orders go through the same path the
 * Android app uses; pickup orders have their own (see db.orderEntry).
 * Prices, container percentages and the GST rate are all re-read here, and
 * the totals recomputed, so nothing the renderer displays is trusted.
 * ---------------------------------------------------------------------------
 */

export function getTaxRate(): Promise<TaxRate> {
  return db.orderEntry.getTaxRate(config.outletId);
}

export async function placeOrder(payload: PlaceOrderPayload): Promise<PlaceOrderResult> {
  if (!config.outletId) throw new Error('OUTLET_ID is not configured for this machine.');
  if (!payload.items?.length) throw new Error('Add at least one item to the order.');
  const isDineIn = payload.orderType === DINE_IN_ORDER_TYPE;
  if (isDineIn && !payload.tableId) throw new Error('Select a table for a dine-in order.');

  const menu = new Map<string, Record<string, unknown>>();
  for (const it of getCachedMenuItems().items) menu.set(String(it.id), it);

  const lines: PricedLine[] = [];
  const newLines: NewOrderLine[] = [];
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
    newLines.push({
      menuItemId: l.menuItemId,
      unitPrice: unit,
      totalPrice: Math.round(unit * qty * 100) / 100,
      quantity: qty,
    });
  }

  const tax = await getTaxRate();
  const totals = computeTotals(lines, tax.ratePercent, !isDineIn);

  let orderId: string;
  if (isDineIn) {
    const tableStatus = await db.tables.getStatusById(payload.tableId as string);
    if (tableStatus === 'reserved' || tableStatus === 'cleaning') {
      throw new Error(`This table is ${tableStatus}. Change its status on the Tables page first.`);
    }
    orderId = await db.orderEntry.placeDineInOrder({
      outletId: config.outletId,
      tableId: payload.tableId as string,
      items: newLines,
      subtotal: totals.subtotal,
      tax: totals.tax,
      total: totals.total,
    });
  } else {
    orderId = await db.orderEntry.placePickupOrder({
      outletId: config.outletId,
      items: newLines,
      subtotal: totals.subtotal,
      tax: totals.tax,
      containerCharge: totals.containerCharge,
      total: totals.total,
      customerName: payload.customerName?.trim() || null,
      customerPhone: payload.customerPhone?.trim() || null,
      notes: payload.notes?.trim() || null,
    });
  }

  // Best effort: the order is already placed, so a failed lookup only means
  // the confirmation shows fewer details.
  const { orderNumber, invoiceNumber } = await db.orderEntry.getOrderSummary(orderId);
  return { orderId, orderNumber, invoiceNumber, total: totals.total };
}
