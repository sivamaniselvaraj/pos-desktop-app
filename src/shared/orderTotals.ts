/**
 * Totals for the New Order page. Used by the renderer (live cart) and by the
 * main process (recomputed before the order is sent). The database
 * recalculates authoritatively when the order is placed; this mirrors it.
 *
 * Tax is per line (each line carries its own category rate). Lines are
 * grouped by rate, the taxable amount of each rate is summed and tax is
 * rounded ONCE per rate. Packaging is taxed at the item's own rate.
 * A line whose price includes tax has the tax taken out of its price
 * (gross * rate / (100 + rate)); the subtotal is always the value before tax,
 * so total = subtotal + container charge + tax in both cases.
 */
import type { TaxBreakdownLine } from './types';

export interface PricedLine {
  unitPrice: number;
  quantity: number;
  /** menu_items.container_charge: a percentage of the line total (pickup only). */
  containerPercent: number;
  taxName: string;
  taxPercent: number;
  /** The unit price already contains the tax. */
  priceIncludesTax?: boolean;
}

export interface OrderTotals {
  subtotal: number;
  tax: number;
  containerCharge: number;
  total: number;
  breakdown: TaxBreakdownLine[];
  containerPercent?: number;
}

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export function computeTotals(lines: PricedLine[], includeContainer: boolean): OrderTotals {
  const containerCharge = includeContainer
    ? r2(lines.reduce((s, l) => s + (l.unitPrice * l.quantity * l.containerPercent) / 100, 0))
    : 0;

  let containerPercent = 0;

  const slabs = new Map<
    string,
    { name: string; rate: number; exclTaxable: number; inclGross: number; exclBase: number }
  >();
  for (const l of lines) {
    const base = l.unitPrice * l.quantity;
    const pack = includeContainer ? (base * l.containerPercent) / 100 : 0;
    const key = `${l.taxName}|${l.taxPercent}`;
    const s = slabs.get(key) ?? { name: l.taxName, rate: l.taxPercent, exclTaxable: 0, inclGross: 0, exclBase: 0 };
    if (l.priceIncludesTax) {
      s.exclTaxable += pack;
      s.inclGross += base;
    } else {
      s.exclTaxable += base + pack;
      s.exclBase += base;
    }
    slabs.set(key, s);
    containerPercent = includeContainer && l.containerPercent > 0 ? l.containerPercent : 0;
  }
  let netBase = 0;
  const breakdown: TaxBreakdownLine[] = [...slabs.values()]
    .map((s) => {
      const inclTax = r2((s.inclGross * s.rate) / (100 + s.rate));
      netBase += s.exclBase + s.inclGross - inclTax;
      return {
        name: s.name,
        rate: s.rate,
        taxable: r2(s.exclTaxable + s.inclGross - inclTax),
        tax: r2(r2((s.exclTaxable * s.rate) / 100) + inclTax),
      };
    })
    .sort((a, b) => a.rate - b.rate || a.name.localeCompare(b.name));
  const subtotal = r2(netBase);
  const tax = r2(breakdown.reduce((s, b) => s + b.tax, 0));
  return { subtotal, tax, containerCharge, total: r2(subtotal + tax + containerCharge), breakdown, containerPercent: containerPercent};
}

/** Combine the per-rate tax of several orders (a grouped table bill): one line per rate. */
export function mergeTaxBreakdowns(lists: (TaxBreakdownLine[] | undefined)[]): TaxBreakdownLine[] {
  const m = new Map<string, TaxBreakdownLine>();
  for (const list of lists) {
    for (const b of list ?? []) {
      const key = `${b.name}|${b.rate}`;
      const cur = m.get(key) ?? { name: b.name, rate: b.rate, taxable: 0, tax: 0 };
      cur.taxable = r2(cur.taxable + b.taxable);
      cur.tax = r2(cur.tax + b.tax);
      m.set(key, cur);
    }
  }
  return [...m.values()].sort((a, b) => a.rate - b.rate || a.name.localeCompare(b.name));
}

const r2b = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const pct = (n: number): string => `${Number.isInteger(n) ? n : Number(n.toFixed(3))}%`;

/**
 * The tax lines of a bill: one per rate. A "GST" rate is shown as CGST + SGST
 * halves (the second takes the odd paisa so the halves add up exactly); any
 * other tax name is shown as is. Orders without a breakdown (placed before
 * per-rate tax) get the single "Tax (GST)" line.
 */
export function taxBillLines(
  breakdown: TaxBreakdownLine[] | undefined,
  totalTax: number,
): { label: string; amount: number }[] {
  if (!breakdown || breakdown.length === 0) return [{ label: 'Tax (GST)', amount: totalTax }];
  const out: { label: string; amount: number }[] = [];
  for (const b of breakdown) {
    if (b.name.trim().toUpperCase() === 'GST') {
      const half = pct(b.rate / 2);
      const cgst = r2b(Math.floor((b.tax * 100) / 2) / 100);
      out.push({ label: `CGST ${half}`, amount: cgst });
      out.push({ label: `SGST ${half}`, amount: r2b(b.tax - cgst) });
    } else {
      out.push({ label: `${b.name} ${pct(b.rate)}`, amount: b.tax });
    }
  }
  return out;
}
