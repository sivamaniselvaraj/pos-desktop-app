import { getAuthedClient } from './sessionClient';
import { getServiceClient } from './serviceClient';
import type { UserRepository } from '../ports';
import type { CreateUserPayload, ManagedUser, UserRole } from '../../../shared/types';

function mapUserRow(row: Record<string, unknown>): ManagedUser {
  return {
    userId: String(row.user_id ?? ''),
    email: String(row.email ?? ''),
    fullName: String(row.full_name ?? ''),
    phone: row.phone ? String(row.phone) : undefined,
    role: (row.role as UserRole) ?? 'staff',
    isActive: row.is_active === true,
    outletId: row.outlet_id ? String(row.outlet_id) : undefined,
    outletName: row.outlet_name ? String(row.outlet_name) : undefined,
    createdAt: String(row.created_at ?? ''),
  };
}

/**
 * Server-side check that the signed-in caller may create this user: they can
 * manage users, the outlet belongs to THEIR organization and the role is a
 * known one. Returns the organization the new profile must belong to.
 */
async function assertCanCreate(outletId: string, role: string): Promise<string> {
  const { data, error } = await getAuthedClient().rpc('assert_can_create_user', {
    p_outlet_id: outletId,
    p_role: role,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

/**
 * Preferred path: the `admin-create-user` Edge Function (supabase/functions/).
 * The service_role key lives only in the function's own environment. Returns
 * false when the function isn't deployed yet so the caller can fall back.
 */
async function createViaEdgeFunction(payload: CreateUserPayload): Promise<boolean> {
  const { error } = await getAuthedClient().functions.invoke('admin-create-user', {
    body: {
      email: payload.email,
      password: payload.password,
      fullName: payload.fullName,
      phone: payload.phone ?? null,
      role: payload.role,
      outletId: payload.outletId,
    },
  });
  if (!error) return true;

  const ctx = (error as { context?: Response }).context;
  if (ctx && typeof ctx.status === 'number') {
    if (ctx.status === 404) return false; // not deployed
    let message = error.message;
    try {
      const body = (await ctx.clone().json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* keep the generic message */
    }
    throw new Error(message);
  }
  throw new Error(error.message);
}

export const users: UserRepository = {
  /** Every user of the caller's organization. Empty for a non-admin caller. */
  async listUsers() {
    const { data, error } = await getAuthedClient().rpc('list_users');
    if (error) throw new Error(error.message);
    return ((data ?? []) as Record<string, unknown>[]).map(mapUserRow);
  },

  // RLS ("members read own org outlets") limits this to the caller's organization.
  async listOutlets() {
    const { data, error } = await getAuthedClient().from('outlets').select('id, name').order('name');
    if (error) throw new Error(error.message);
    return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id ?? ''),
      name: String(row.name ?? ''),
    }));
  },

  /**
   * 1. Verified server-side first (assert_can_create_user).
   * 2. Created by the Edge Function when deployed.
   * 3. LEGACY fallback: the local service_role client, only when
   *    SUPABASE_SERVICE_ROLE_KEY is configured. Deprecated.
   */
  async create(payload) {
    if (!payload.outletId) throw new Error('Select an outlet for the new user.');
    const orgId = await assertCanCreate(payload.outletId, payload.role);
    if (await createViaEdgeFunction(payload)) return;

    console.warn('admin-create-user Edge Function is not deployed; using the local service_role key (deprecated).');
    const admin = getServiceClient();

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: payload.email,
      password: payload.password,
      email_confirm: true,
    });
    console.log("admin createUser", created, createError)
    if (createError) throw new Error(createError.message);

    const newUserId = created.user?.id;

    if (!newUserId) throw new Error('User creation did not return a user id.');

    const { data: updated, error: profileError } = await admin.from('profiles').update({
      //user_id: newUserId,
      //email: payload.email,
      first_name: payload.fullName,
      //last_name: '',
      phone: payload.phone ?? null,
      role: payload.role,
      outlet_id: payload.outletId,
      org_id: orgId,
      //is_active: true,
    }).eq('user_id', newUserId)
    .select('user_id');
   if (profileError || !updated || updated.length === 0) {
      // Best-effort cleanup: don't leave a login with no profile behind.
      await admin.auth.admin.deleteUser(newUserId).catch(() => undefined);
      const { error: profileDeleteError } =  await admin.from('profiles') .delete().eq('user_id', newUserId);
      console.log(profileDeleteError);
      throw new Error(profileError?.message);
    }
  },

  async update(payload) {
    const { error } = await getAuthedClient().rpc('update_user_profile', {
      p_user_id: payload.userId,
      p_full_name: payload.fullName,
      p_phone: payload.phone ?? null,
      p_role: payload.role,
      p_outlet_id: payload.outletId,
    });
    if (error) throw new Error(error.message);
  },

  async setActive(userId, isActive) {
    const { error } = await getAuthedClient().rpc('set_user_active', {
      p_user_id: userId,
      p_is_active: isActive,
    });
    if (error) throw new Error(error.message);
  },
};
