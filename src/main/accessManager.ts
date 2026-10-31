import { db } from './data';
import { config } from './config';
import type { MyAccess, ReceiptText } from '../shared/types';

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
  return db.access.setBrandColor(c === '' ? null : c.toLowerCase());
}

export function getMyAccess(): Promise<MyAccess | null> {
  return db.access.fetchMyAccess();
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
  const clean = { header: cleanReceiptLines('header', text?.header), footer: cleanReceiptLines('footer', text?.footer) };
  await db.access.setReceiptText(config.outletId, clean);
  return clean;
}
