import { db } from './data';
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
  return db.users.create(payload);
}

/** Admin edits another user's profile fields (not email/password). */
export function updateUser(payload: UpdateUserPayload): Promise<void> {
  return db.users.update(payload);
}

/** Soft delete (false) / reactivate (true). Never removes the row or the login. */
export function setUserActive(userId: string, isActive: boolean): Promise<void> {
  return db.users.setActive(userId, isActive);
}

// ---------------------------------------------------------------------------
// User groups: a member inherits everything the group grants, on top of the role.
// ---------------------------------------------------------------------------
export const listGroups = (): Promise<UserGroup[]> => db.groups.listGroups();
export const listPermissions = (): Promise<PermissionInfo[]> => db.groups.listPermissions();
export const listGroupMemberships = (): Promise<GroupMembership[]> => db.groups.listMemberships();
export const saveGroup = (payload: SaveGroupPayload): Promise<string> => db.groups.save(payload);
export const deleteGroup = (groupId: string): Promise<void> => db.groups.delete(groupId);
export const setGroupMembers = (groupId: string, userIds: string[]): Promise<void> =>
  db.groups.setMembers(groupId, userIds);
export const setUserGroups = (userId: string, groupIds: string[]): Promise<void> =>
  db.groups.setUserGroups(userId, groupIds);
export const getUserAccess = (userId: string): Promise<UserAccessEntry[]> =>
  db.groups.userAccess(userId);
