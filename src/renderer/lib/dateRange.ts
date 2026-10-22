import { dateInOrgZone } from './format';

export type Preset = 'today' | 'yesterday' | 'thisMonth' | 'lastMonth' | 'custom';

export const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'thisMonth', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
  { key: 'custom', label: 'Custom range' },
];

// Calendar arithmetic on YYYY-MM-DD strings (UTC), so it never shifts with the computer's time zone.
const parse = (s: string): Date => new Date(`${s}T00:00:00Z`);
const iso = (d: Date): string => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number): string => {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};

/** The date range for a preset, as seen in the organization's time zone. */
export function presetRange(p: Exclude<Preset, 'custom'>): { from: string; to: string } {
  const today = dateInOrgZone(new Date());
  if (p === 'today') return { from: today, to: today };
  if (p === 'yesterday') {
    const y = addDays(today, -1);
    return { from: y, to: y };
  }
  const first = `${today.slice(0, 8)}01`;
  if (p === 'thisMonth') return { from: first, to: today };
  const lastDay = addDays(first, -1); // last month
  return { from: `${lastDay.slice(0, 8)}01`, to: lastDay };
}
