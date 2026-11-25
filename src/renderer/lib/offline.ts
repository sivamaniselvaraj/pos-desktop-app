import type { OfflineStatus } from '@shared/offlineTypes';

/** "5:42 PM" today, else "21 Nov, 5:42 PM". */
export function shortTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never';
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`;
}

/** The header pill's word for the connection. */
export function connectionLabel(s: OfflineStatus | null): string {
  switch (s?.state) {
    case 'online':
      return 'Online';
    case 'syncing':
      return 'Syncing';
    case 'offline':
      return 'Offline';
    default:
      return 'Checking';
  }
}

/** One line on this computer's copy, for the tooltip and the banner. */
export function localCopyLine(s: OfflineStatus | null): string {
  if (!s) return 'Not known yet';
  if (s.localStore === 'unavailable') return `Not available${s.localStoreError ? ` (${s.localStoreError})` : ''}`;
  return s.localCopyAt ? `Saved ${shortTime(s.localCopyAt)}` : 'Nothing saved yet';
}
