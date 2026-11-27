import { db, offline } from './data';
import { config } from './config';
import { createSwrCache } from './swrCache';
import type { MyAccess, OrgSettings, ReceiptText } from '../shared/types';

/**
 * accessManager.ts
 * ---------------------------------------------------------------------------
 * Loads the signed-in user's permissions and sidebar menus from the database
 * (get_my_access). Access is managed ONLY through user groups: what a user can
 * do is the union of the permissions of the groups they belong to (admins
 * always pass, so the organization can never lock itself out). This drives
 * what the UI SHOWS; the database still enforces what the user may DO.
 *
 * There is no built-in fallback. If the database can't answer, the caller
 * gets null and the UI shows no access rather than guessing from the role.
 * ---------------------------------------------------------------------------
 */
/** The business's app colour: #rrggbb, or null to go back to the default. The database checks branding.manage. */
export async function saveBrandColor(color: string | null): Promise<string | null> {
  const c = typeof color === 'string' ? color.trim() : '';
  if (c !== '' && !/^#[0-9a-fA-F]{6}$/.test(c)) throw new Error('Enter a colour as # and six letters or digits, for example #4caf50.');
  const saved = await db.access.setBrandColor(c === '' ? null : c.toLowerCase());
  invalidateAccessForPhones(); // the organisation's settings changed
  return saved;
}

export function getMyAccess(): Promise<MyAccess | null> {
  return db.access.fetchMyAccess();
}

/*
 * The organisation settings phones get in GET /api/me (docs/API_CACHE.md). They
 * come from get_my_access of the user signed in on THIS desktop (the phone's own
 * device name and user id are read per request, never cached), so the cache is
 * keyed by that user and this PC's outlet: after a sign-out, another sign-in or
 * an outlet change the old answer is never served. Fresh for 30 seconds, then
 * answered at once for up to 5 minutes while one refresh runs in the background
 * (not while offline). Dropped on sign-in, sign-out, session restore, a colour
 * save and any change to users or groups on this PC. No answer (null, no org) is
 * never cached: the phone gets the defaults, as before.
 */
export const PHONE_ACCESS_FRESH_MS = 30_000;
export const PHONE_ACCESS_STALE_MS = 5 * 60_000;
class NoOrgSettings extends Error {}
let sessionUserId = '';

const orgCache = createSwrCache<OrgSettings>({
  load: async () => {
    const org = (await getMyAccess())?.org;
    if (!org) throw new NoOrgSettings('No organisation settings.');
    return org;
  },
  freshMs: PHONE_ACCESS_FRESH_MS,
  staleMs: PHONE_ACCESS_STALE_MS,
  allowStale: () => !offline.monitor.isOffline(),
  key: () => `${sessionUserId}|${config.outletId}`,
  onBackgroundError: (err:any) => {
    if (!(err instanceof NoOrgSettings)) console.warn('[api] settings refresh failed:', err instanceof Error ? err.message : err);
  },
});

/** The desktop's signed-in user changed (sign-in, sign-out, session restore): drop the phones' settings cache. */
export function setAccessSessionUser(userId: string | null): void {
  sessionUserId = userId ?? '';
  orgCache.invalidate();
}

/** Permissions, groups or organisation settings changed: the next GET /api/me reads them again. */
export function invalidateAccessForPhones(): void {
  orgCache.invalidate();
}

/** The organisation settings for GET /api/me, through the cache above; null when the database gave none. */
export async function getOrgSettingsForPhones(): Promise<OrgSettings | null> {
  try {
    return await orgCache.get();
  } catch (err) {
    if (err instanceof NoOrgSettings) return null;
    throw err;
  }
}

const RECEIPT_MAX_LINES = 8;
const RECEIPT_MAX_LINE = 48; // characters on an 80 mm bill

/** One line per row; trims, drops blank lines and checks the limits the paper allows. */
function cleanReceiptLines(label: string, raw: string): string {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length > RECEIPT_MAX_LINES) throw new Error(`The ${label} can have at most ${RECEIPT_MAX_LINES} lines.`);
  const long = lines.findIndex((l) => l.length > RECEIPT_MAX_LINE);
  if (long >= 0) throw new Error(`${label[0].toUpperCase()}${label.slice(1)} line ${long + 1} is longer than ${RECEIPT_MAX_LINE} characters.`);
  return lines.join('\n');
}

/** The signed-in outlet's bill header/footer lines. */
export function getReceiptText(): Promise<ReceiptText> {
  return db.access.getReceiptText(config.outletId);
}

/** Saves the header/footer lines for the signed-in outlet. The database checks receipt.manage. */
export async function saveReceiptText(text: ReceiptText): Promise<ReceiptText> {
  const clean = { businessName: text?.businessName, header: cleanReceiptLines('header', text?.header), footer: cleanReceiptLines('footer', text?.footer) };
  await db.access.setReceiptText(config.outletId, clean);
  return clean;
}
