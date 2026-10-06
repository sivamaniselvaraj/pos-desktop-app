import { getAuthedClient } from './sessionClient';
import type { GroupRepository } from '../ports';

/** Every call is authorized server-side (users.manage, caller's organization only). */
export const groups: GroupRepository = {
  async listGroups() {
    const { data, error } = await getAuthedClient().rpc('list_groups');
    if (error) throw new Error(error.message);
    return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      description: String(r.description ?? ''),
      memberCount: Number(r.member_count ?? 0),
      permissions: ((r.permissions ?? []) as unknown[]).map(String),
    }));
  },

  async listPermissions() {
    const { data, error } = await getAuthedClient()
      .from('permissions')
      .select('code, description')
      .order('code');
    if (error) throw new Error(error.message);
    return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      code: String(r.code ?? ''),
      description: String(r.description ?? ''),
    }));
  },

  async listMemberships() {
    const { data, error } = await getAuthedClient().rpc('list_group_memberships');
    if (error) throw new Error(error.message);
    return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      userId: String(r.user_id ?? ''),
      groupId: String(r.group_id ?? ''),
    }));
  },

  async save(payload) {
    const { data, error } = await getAuthedClient().rpc('save_group', {
      p_id: payload.id ?? null,
      p_name: payload.name,
      p_description: payload.description,
      p_permissions: payload.permissions,
    });
    if (error) throw new Error(error.message);
    return String(data);
  },

  async delete(groupId) {
    const { error } = await getAuthedClient().rpc('delete_group', { p_id: groupId });
    if (error) throw new Error(error.message);
  },

  async setMembers(groupId, userIds) {
    const { error } = await getAuthedClient().rpc('set_group_members', {
      p_group_id: groupId,
      p_user_ids: userIds,
    });
    if (error) throw new Error(error.message);
  },

  async setUserGroups(userId, groupIds) {
    const { error } = await getAuthedClient().rpc('set_user_groups', {
      p_user_id: userId,
      p_group_ids: groupIds,
    });
    if (error) throw new Error(error.message);
  },

  async userAccess(userId) {
    const [{ data, error }, perms] = await Promise.all([
      getAuthedClient().rpc('user_effective_access', { p_user_id: userId }),
      groups.listPermissions(),
    ]);
    if (error) throw new Error(error.message);
    const desc = new Map(perms.map((p) => [p.code, p.description]));
    return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      permission: String(r.permission_code ?? ''),
      description: desc.get(String(r.permission_code ?? '')) ?? '',
      via: ((r.via ?? []) as unknown[]).map(String),
    }));
  },
};
