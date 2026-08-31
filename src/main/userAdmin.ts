import { getAuthedClient } from './supabaseAuthClient';
import { getServiceClient } from './supabaseServiceClient';
import type {
  ManagedUser,
  OutletOption,
  CreateUserPayload,
  UpdateUserPayload,
  UserRole,
} from '../shared/types';

/**
 * userAdmin.ts
 * ---------------------------------------------------------------------------
 * User management for the admin-only User Management page.
 *
 * listUsers / listOutlets / updateUser / setUserActive all go through the
 * normal session client and RLS-safe, admin-gated SQL RPCs (see the "USER
 * MANAGEMENT RPCs" section of db/functions.sql) — the database itself
 * refuses these for a non-admin caller.
 *
 * createUser is different: it must call Supabase's Auth Admin API (to set a
 * password), which requires the service_role key and therefore bypasses RLS
 * entirely. Since the database can't gate this one, assertCallerIsAdmin()
 * performs the same admin check in application code, via the normal session
 * client, before the service-role client is ever touched.
 * ---------------------------------------------------------------------------
 */

function mapUserRow(row: Record<string, unknown>): ManagedUser {
  return {
    userId: String(row.user_id ?? ''),
    email: String(row.email ?? ''),
    firstName: String(row.first_name ?? ''),
    phone: row.phone ? String(row.phone) : undefined,
    role: (row.role as UserRole) ?? 'staff',
    isActive: row.is_active === true,
    outletId: row.outlet_id ? String(row.outlet_id) : undefined,
    outletName: row.outlet_name ? String(row.outlet_name) : undefined,
    createdAt: String(row.created_at ?? ''),
  };
}

/** Every user account, active or deactivated, across all outlets. Empty for a non-admin caller. */
export async function listUsers(): Promise<ManagedUser[]> {
  const supabase = getAuthedClient();
  const { data, error } = await supabase.rpc('list_users');
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map(mapUserRow);
}

/** Outlets for the create/edit form's dropdown. Not admin-gated — see the RPC's own comment. */
export async function listOutlets(): Promise<OutletOption[]> {
  const supabase = getAuthedClient();
  const { data, error } = await supabase.rpc('list_outlets');
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
  }));
}

/**
 * The database can't gate createUser() (the service_role client below
 * bypasses RLS by design), so this is the application-level substitute:
 * confirm the CURRENTLY SIGNED-IN operator is an admin, via the normal
 * session client, before touching the elevated one.
 */
async function assertCallerIsAdmin(): Promise<void> {
  const supabase = getAuthedClient();
  const { data, error } = await supabase.rpc('is_admin');
  if (error) throw new Error(error.message);
  if (data !== true) throw new Error('Only admins can perform this action.');
}

/**
 * Creates a login (Supabase Auth user) and its profile row. Uses the
 * service_role client — see assertCallerIsAdmin() above and
 * supabaseServiceClient.ts for why that's safe here.
 *
 * If the profile insert fails after the auth user was created, the orphaned
 * auth user is best-effort cleaned up so a failed "create user" doesn't
 * leave a login with no profile behind it.
 */
export async function createUser(payload: CreateUserPayload): Promise<void> {
  await assertCallerIsAdmin();

  const admin = getServiceClient();

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: payload.email,
    password: payload.password,
    email_confirm: true,
  });
  if (createError) throw new Error(createError.message);

  const newUserId = created.user?.id;
  if (!newUserId) throw new Error('User creation did not return a user id.');

  const { error: profileError } = await admin.from('profiles').insert({
    user_id: newUserId,
    email: payload.email,
    first_name: payload.firstName,
    phone: payload.phone ?? null,
    role: payload.role,
    outlet_id: payload.outletId ?? null,
    is_active: true,
  });

  if (profileError) {
    // Best-effort cleanup — don't leave a login with no profile behind.
    await admin.auth.admin.deleteUser(newUserId).catch(() => undefined);
    throw new Error(profileError.message);
  }
}

/** Admin edits another user's profile fields (not email/password — see the RPC's comment). */
export async function updateUser(payload: UpdateUserPayload): Promise<void> {
  const supabase = getAuthedClient();
  const { error } = await supabase.rpc('update_user_profile', {
    p_user_id: payload.userId,
    p_first_name: payload.firstName,
    p_phone: payload.phone ?? null,
    p_role: payload.role,
    p_outlet_id: payload.outletId ?? null,
  });
  if (error) throw new Error(error.message);
}

/** Soft delete (false) / reactivate (true). Never removes the row or the login. */
export async function setUserActive(userId: string, isActive: boolean): Promise<void> {
  const supabase = getAuthedClient();
  const { error } = await supabase.rpc('set_user_active', {
    p_user_id: userId,
    p_is_active: isActive,
  });
  if (error) throw new Error(error.message);
}
