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
export function getMyAccess(): Promise<MyAccess | null> {
  return db.access.fetchMyAccess();
}
