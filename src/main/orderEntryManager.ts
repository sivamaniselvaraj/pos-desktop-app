import { db, type NewOrderLine } from './data';
import { getCachedMenuItems } from './menuCache';
import { config } from './config';
import { computeTotals, type PricedLine } from '../shared/orderTotals';
import type { OrderType, PlaceOrderPayload, PlaceOrderResult, TaxRates } from '../shared/types';
import {
  DINE_IN_ORDER_TYPE,
  PICK_UP_ORDER_TYPE,
}from '../shared/types';
import { printQueue } from './printQueue';
import { orderManager } from './orderManager';

/**
 * orderEntryManager.ts
 * ---------------------------------------------------------------------------
 * Backs the New Order page. Dine-in orders go through the same path the
 * Android app uses; pickup orders have their own (see db.orderEntry).
 * Prices, container percentages and the GST rate are all re-read here, and
 * the totals recomputed, so nothing the renderer displays is trusted.
 * ---------------------------------------------------------------------------
 */

export function getTaxRate(): Promise<TaxRates> {
  return db.orderEntry.getTaxRates();
}

export async function placeOrder(payload: PlaceOrderPayload): Promise<PlaceOrderResult> {
  if (!config.outletId) throw new Error('OUTLET_ID is not configured for this machine.');
  if (!payload.items?.length) throw new Error('Add at least one item to the order.');
  const isDineIn = payload.orderType === DINE_IN_ORDER_TYPE;
  if (isDineIn && !payload.tableId) throw new Error('Select a table for a dine-in order.');

  const menu = new Map<string, Record<string, unknown>>();
  for (const it of getCachedMenuItems().items) menu.set(String(it.id), it);

  const rates = await getTaxRate();
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
    // The item's own tax replaces the category rate; older items without one fall back to it.
    const itemRate =
      m.tax_rate_percent !== null && m.tax_rate_percent !== undefined && Number.isFinite(Number(m.tax_rate_percent))
        ? { name: String(m.tax_name ?? 'GST'), ratePercent: Number(m.tax_rate_percent) }
        : null;
    const rate = itemRate ?? (m.category_id ? rates.byCategory[String(m.category_id)] : undefined) ?? rates.defaultRate;
    lines.push({
      priceIncludesTax: itemRate !== null && m.price_includes_tax === true,
      unitPrice: unit,
      quantity: qty,
      containerPercent: Number(m.container_charge ?? 0) || 0,
      taxName: rate.name,
      taxPercent: rate.ratePercent,
    });
    newLines.push({
      menuItemId: l.menuItemId,
      unitPrice: unit,
      totalPrice: Math.round(unit * qty * 100) / 100,
      quantity: qty,
    });
  }

  // Estimate only: the database recalculates tax and total when it saves the order.
  const totals = computeTotals(lines, !isDineIn);

  let result: { orderId?: string; orderNumber?: number; invoiceNumber?: string, duplicate?: boolean };
  let orderDetail: { 
      userId: string,
      orderType: OrderType
      outletId: string;
      tableId: string;
      items: NewOrderLine[];
      customerName: string | null;
      customerPhone: string | null;
      notes: string | null;
  };

  if (isDineIn) {
    const tableStatus = await db.tables.getStatusById(payload.tableId as string);
    if (tableStatus === 'reserved' || tableStatus === 'cleaning') {
      throw new Error(`This table is ${tableStatus}. Change its status on the Tables page first.`);
    }
  }

  result = await db.orderEntry.placeNewOrder({
    userId: payload.placedBy,
    orderType: isDineIn ? DINE_IN_ORDER_TYPE : PICK_UP_ORDER_TYPE,
    outletId: config.outletId,
    tableId: payload.tableId as string,
    items: newLines,
    customerName: payload.customerName?.trim() || null,
    customerPhone: payload.customerPhone?.trim() || null,
    notes: payload.notes?.trim() || null,
  })

  // Best effort: the order is already placed, so a failed lookup only means
  // the confirmation shows fewer details.
  //const { orderNumber, invoiceNumber } = await db.orderEntry.getOrderSummary(orderId);
  if (!result.orderId) throw new Error('The order was not created.');

  if (config.outletId && result.orderId) {
      printQueue
        .enqueue(() => orderManager.handleIncoming(String(result.orderId), 'kot'))
        .then((r) => {
          if (!r.success) console.warn(`[Entry Manager] KOT for order ${result.orderNumber} not printed: ${r.message}`);
        })
        .catch((err) => console.error('[Entry Manager] KOT print failed:', err instanceof Error ? err.message : err));
    }

    return { orderId: String(result.orderId), orderNumber: Number(result.orderNumber ?? 0), invoiceNumber: String(result.invoiceNumber), total: totals.total, duplicate: result.duplicate === true };
  //return { orderId, orderNumber, invoiceNumber, total: totals.total };
}
