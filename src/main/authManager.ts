import { config, setRuntimeOutletId } from './config';
import { db, type UserProfile } from './data';
import { refreshMenuCache, clearMenuCache } from './menuCache';
import type { AuthResult, AuthUser } from '../shared/types';

/**
 * authManager.ts
 * ---------------------------------------------------------------------------
 * Auth business logic: sign in/out, session restore, and authorization
 * (profile must exist and be active). The identity provider itself is behind
 * db.auth (src/main/data) — this module knows nothing about it.
 * ---------------------------------------------------------------------------
 */

async function toAuthUser(id: string, email: string, profile: UserProfile): Promise<AuthUser> {
  // A lookup failure here shouldn't fail sign-in, just leave outletName unset.
  const outletName = profile.outletId ? await db.auth.loadOutletName(profile.outletId) : undefined;
  return {
    id,
    email: profile.email ?? email,
    fullName: profile.fullName ?? '',
    role: profile.role ?? 'staff',
    isActive: profile.isActive ?? false,
    outletId: profile.outletId ?? undefined,
    outletName,
  };
}

// When this machine has no OUTLET_ID configured, serve the signed-in user's own
// outlet (menu cache, order entry) instead of nothing. A configured OUTLET_ID
// always wins.
function bindOutlet(outletId: string | null | undefined): void {
  if (process.env.OUTLET_ID || !outletId || config.outletId === outletId) return;
  setRuntimeOutletId(outletId);
  void refreshMenuCache();
}

// Authenticates, then authorizes: the account must have a profile and be active.
export async function signIn(email: string, password: string): Promise<AuthResult> {
  try {
    const res = await db.auth.signIn(email, password);
    if (!res.ok) return { success: false, error: res.error };
    console.log("reserr" , res)
    
    const profile = await db.auth.loadProfile(res.user.id);
    if (!profile) {
      await db.auth.signOut();
      return { success: false, error: 'No profile is associated with this account.' };
    }
    if (!profile.isActive) {
      await db.auth.signOut();
      return { success: false, error: 'This account has been disabled. Contact an administrator.' };
    }

    bindOutlet(profile.outletId);
    return { success: true, user: await toAuthUser(res.user.id, res.user.email || email, profile) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Sign in failed.' };
  }
}

export async function signOut(): Promise<void> {
  if (!db.isConfigured()) return;
  try {
    await db.auth.signOut();
  } catch (err) {
    console.error('Sign out error:', err);
  }
  if (!process.env.OUTLET_ID) {
    setRuntimeOutletId('');
    clearMenuCache();
  }
}

// Restores a persisted session on app start; re-validates authorization.
export async function getCurrentUser(): Promise<AuthUser | null> {
  if (!db.isConfigured()) return null;
  try {
    const user = await db.auth.getSessionUser();
    if (!user) return null;

    const profile = await db.auth.loadProfile(user.id);
    if (!profile || !profile.isActive) {
      await db.auth.signOut();
      return null;
    }
    bindOutlet(profile.outletId);
    return await toAuthUser(user.id, user.email, profile);
  } catch {
    return null;
  }
}
