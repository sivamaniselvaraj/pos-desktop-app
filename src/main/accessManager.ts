import { db } from './data';
import type { MyAccess } from '../shared/types';

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
