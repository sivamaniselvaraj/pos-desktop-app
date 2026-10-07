/**
 * Organization-aware formatting (currency, locale, timezone, tax label).
 * The values come from the signed-in user's organization (get_my_access) and
 * are installed once after sign-in by AuthContext; until then the defaults
 * below (the original India settings) apply.
 */
import type { OrgSettings } from '@shared/types';

const DEFAULTS: OrgSettings = {
  id: '',
  name: '',
  currencyCode: 'INR',
  locale: 'en-IN',
  timezone: 'Asia/Kolkata',
  taxLabel: 'GST',
};

let org: OrgSettings = DEFAULTS;

export function setOrgFormat(next: OrgSettings | null): void {
  org = next ?? DEFAULTS;
}

/** The currency symbol for the organization's currency, e.g. "₹". */
export function currencySymbol(): string {
  try {
    const part = new Intl.NumberFormat(org.locale, { style: 'currency', currency: org.currencyCode })
      .formatToParts(0)
      .find((p) => p.type === 'currency');
    return part?.value ?? org.currencyCode;
  } catch {
    return org.currencyCode;
  }
}

/** "₹ 1234.50" — symbol, a space, two decimals (the app's existing money format). */
export function formatMoney(n: number): string {
  return `${currencySymbol()} ${n.toFixed(2)}`;
}

/** A number with the organization's digit grouping (chart axes etc.). */
export function formatNumber(n: number): string {
  return n.toLocaleString(org.locale);
}

/** Date and time in the organization's locale and timezone. */
export function formatDateTime(value: string | number | Date): string {
  return new Date(value).toLocaleString(org.locale, { timeZone: org.timezone });
}

/** YYYY-MM-DD of a date as seen in the organization's timezone. */
export function dateInOrgZone(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone }).format(d);
}

export function taxLabel(): string {
  return org.taxLabel;
}
