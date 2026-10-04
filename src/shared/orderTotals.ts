/**
 * Totals for the New Order page. Used by the renderer (live cart) and by the
 * main process (recomputed before the order is sent, so the numbers written
 * to the database never depend on what the renderer displayed).
 */
export interface PricedLine {
  unitPrice: number;
  quantity: number;
  /** menu_items.container_charge: a percentage of the line total (pickup only). */
  containerPercent: number;
}

export interface OrderTotals {
  subtotal: number;
  tax: number;
  containerCharge: number;
  total: number;
}

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Pickup: the container charge is added first and GST is calculated on subtotal + container charge. */
export function computeTotals(
  lines: PricedLine[],
  taxPercent: number,
  includeContainer: boolean,
): OrderTotals {
  const subtotal = r2(lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0));
  const containerCharge = includeContainer
    ? r2(lines.reduce((s, l) => s + (l.unitPrice * l.quantity * l.containerPercent) / 100, 0))
    : 0;
  const tax = r2(((subtotal + containerCharge) * taxPercent) / 100);
  return { subtotal, tax, containerCharge, total: r2(subtotal + tax + containerCharge) };
}
