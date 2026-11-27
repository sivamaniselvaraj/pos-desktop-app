import { db } from './data';
import { invalidateAccessForPhones } from './accessManager';
import type {
  ManagedUser,
  OutletOption,
  CreateUserPayload,
  UpdateUserPayload,
  UserGroup,
  PermissionInfo,
  GroupMembership,
  SaveGroupPayload,
  UserAccessEntry,
} from '../shared/types';

/**
 * userAdmin.ts
 * ---------------------------------------------------------------------------
 * User management for the admin-only User Management page. All the work, and
 * every authorization check, is behind db.users (src/main/data); nothing here
 * depends on which database or identity provider is in use.
 * ---------------------------------------------------------------------------
 */

/** A change to users or groups: the phones' cached GET /api/me settings are read again (docs/API_CACHE.md). */
function accessChanged<T>(p: Promise<T>): Promise<T> {
  return p.finally(invalidateAccessForPhones);
}

/** Every user of the caller's organization, active or deactivated. Empty for a non-admin caller. */
export function listUsers(): Promise<ManagedUser[]> {
  return db.users.listUsers();
}

/** Outlets of the caller's own organization, for the create/edit form's dropdown. */
export function listOutlets(): Promise<OutletOption[]> {
  return db.users.listOutlets();
}

/** Creates a login and its profile. The provider verifies the caller may do this. */
export function createUser(payload: CreateUserPayload): Promise<void> {
  return accessChanged(createUserAndGroups(payload));
}

async function createUserAndGroups(payload: CreateUserPayload): Promise<void> {
  await db.users.create(payload);
  // Access comes only from groups: put the new user in the chosen ones.
  if (payload.groupIds?.length) {
    const email = payload.email.trim().toLowerCase();
    const created = (await db.users.listUsers()).find((u) => u.email.toLowerCase() === email);
    if (!created) throw new Error('User was created but could not be found to add to groups.');
    await db.groups.setUserGroups(created.userId, payload.groupIds);
  }
}

/** Admin edits another user's profile fields (not email/password). */
export function updateUser(payload: UpdateUserPayload): Promise<void> {
  return accessChanged(db.users.update(payload));
}

/** Soft delete (false) / reactivate (true). Never removes the row or the login. */
export function setUserActive(userId: string, isActive: boolean): Promise<void> {
  return accessChanged(db.users.setActive(userId, isActive));
}

// ---------------------------------------------------------------------------
// User groups: a member inherits everything the group grants, on top of the role.
// ---------------------------------------------------------------------------
export const listGroups = (): Promise<UserGroup[]> => db.groups.listGroups();
export const listPermissions = (): Promise<PermissionInfo[]> => db.groups.listPermissions();
export const listGroupMemberships = (): Promise<GroupMembership[]> => db.groups.listMemberships();
export const saveGroup = (payload: SaveGroupPayload): Promise<string> => accessChanged(db.groups.save(payload));
export const deleteGroup = (groupId: string): Promise<void> => accessChanged(db.groups.delete(groupId));
export const setGroupMembers = (groupId: string, userIds: string[]): Promise<void> =>
  accessChanged(db.groups.setMembers(groupId, userIds));
export const setUserGroups = (userId: string, groupIds: string[]): Promise<void> =>
  accessChanged(db.groups.setUserGroups(userId, groupIds));
export const getUserAccess = (userId: string): Promise<UserAccessEntry[]> =>
  db.groups.userAccess(userId);
