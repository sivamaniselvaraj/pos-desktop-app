import { addDays } from '../../lib/dateRange';
import styles from '../../styles/Reports.module.css';

export interface DateRange {
  from: string;
  to: string;
}

export const rangeOk = (r: DateRange): boolean => !!r.from && !!r.to && r.from <= r.to;

export function rangeLabel(r: DateRange): string {
  if (!rangeOk(r)) return 'Pick a valid date range';
  return r.from === r.to ? r.from : `${r.from} to ${r.to}`;
}

/** Number of days in the range, both ends included. */
export function daysIn(r: DateRange): number {
  return Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** The period of the same length just before the range (yesterday for today, last month's first N days...). */
export function previousRange(r: DateRange): DateRange {
  const n = daysIn(r);
  return { from: addDays(r.from, -n), to: addDays(r.from, -1) };
}

/** 'pickup' is shown as Takeaway everywhere in the app. */
export function orderTypeLabel(t: string): string {
  if (t === 'dine-in') return 'Dine-in';
  if (t === 'pickup') return 'Takeaway';
  if (t === 'delivery') return 'Delivery';
  return t || 'Other';
}

export function sourceLabel(s: string): string {
  return s === 'mobile' ? 'Mobile' : 'POS';
}

export function paymentLabel(m: string): string {
  if (m === 'cash') return 'Cash';
  if (m === 'card') return 'Card';
  if (m === 'upi') return 'UPI';
  if (m === 'unpaid') return 'Not recorded';
  return m;
}

export const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Weekdays in the order the reports show them (Monday first, like the Sales report's weeks). */
export const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** "13:00" for hour 13; hourRange(13) = "13:00 to 14:00". */
export const hourLabel = (h: number): string => `${String(h).padStart(2, '0')}:00`;
export const hourRange = (h: number): string => `${hourLabel(h)} to ${hourLabel((h + 1) % 24)}`;

export const share = (part: number, whole: number): number => (whole > 0 ? (part / whole) * 100 : 0);
export const pct1 = (n: number): string => `${n.toFixed(1)}%`;

/** Change against the previous period: "▲ 12.5%", "▼ 3.0%", "new" or "no change". */
export function Delta({ now, before, suffix }: { now: number; before: number; suffix?: string }) {
  if (before === 0 && now === 0) return <small className={styles.flat}>-</small>;
  if (before === 0) return <small className={styles.up}>new {suffix ?? ''}</small>;
  const d = ((now - before) / Math.abs(before)) * 100;
  if (Math.abs(d) < 0.05) return <small className={styles.flat}>no change {suffix ?? ''}</small>;
  return (
    <small className={d > 0 ? styles.up : styles.down}>
      {d > 0 ? '▲' : '▼'} {Math.abs(d).toFixed(1)}% {suffix ?? ''}
    </small>
  );
}

/** Reads the brand colour for chart fills (SVG attributes cannot use CSS variables reliably). */
export function brandColour(name = '--brand', fallback = '#4caf50'): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}
