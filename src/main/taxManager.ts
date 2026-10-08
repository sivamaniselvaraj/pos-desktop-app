import { db } from './data';
import type { AddTaxRatePayload, TaxRateRow } from '../shared/types';

/**
 * taxManager.ts: the Tax rates screen. Rates are append-only and effective-dated
 * (a change never rewrites history); who may use this is enforced in the
 * database (tax.manage). Checks here only give friendlier messages.
 */

export function listTaxRates(): Promise<TaxRateRow[]> {
  return db.tax.list();
}

export function addTaxRate(p: AddTaxRatePayload): Promise<void> {
  const name = p.taxName?.trim();
  if (!name || name.length > 30) throw new Error('Tax name must be 1 to 30 characters.');
  if (p.ratePercent === null) {
    if (!p.categoryId) throw new Error('The default rate needs a value.');
  } else if (typeof p.ratePercent !== 'number' || !(p.ratePercent >= 0 && p.ratePercent <= 100)) {
    throw new Error('Rate must be between 0 and 100.');
  }
  return db.tax.add({ ...p, taxName: name });
}

export function deleteTaxRate(id: string): Promise<void> {
  return db.tax.remove(id);
}
