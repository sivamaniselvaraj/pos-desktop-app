import { type SupabaseClient } from '@supabase/supabase-js';
import { isConfigured } from './config';
import { getAuthedClient } from './supabaseAuthClient';
import type { AuthResult, AuthUser } from '../shared/types';

interface ProfileRow {
  id: string;
  email: string | null;
  first_name: string | null;
  role: string | null;
  is_active: boolean | null;
}

// Reads the signed-in user's own profile (allowed by RLS "read own profile").
async function loadProfile(supabase: SupabaseClient, userId: string): Promise<ProfileRow | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, first_name, role, is_active')
    .eq('user_id', userId)
    .single();
  if (error) return null;
  return data as ProfileRow;
}

function toAuthUser(id: string, email: string, profile: ProfileRow): AuthUser {
  return {
    id,
    email: profile.email ?? email,
    fullName: profile.first_name ?? '',
    role: profile.role ?? 'staff',
    isActive: profile.is_active ?? false,
  };
}

// Authenticates, then authorizes: the account must have a profile and be active.
export async function signIn(email: string, password: string): Promise<AuthResult> {
  try {
    const supabase = getAuthedClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { success: false, error: error.message };
    
    const user = data.user;
    if (!user) return { success: false, error: 'Authentication failed.' };

    const profile = await loadProfile(supabase, user.id);
    if (!profile) {
      await supabase.auth.signOut();
      return { success: false, error: 'No profile is associated with this account.' };
    }
    if (!profile.is_active) {
      await supabase.auth.signOut();
      return { success: false, error: 'This account has been disabled. Contact an administrator.' };
    }

    return { success: true, user: toAuthUser(user.id, user.email ?? email, profile) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Sign in failed.' };
  }
}

export async function signOut(): Promise<void> {
  if (!isConfigured()) return;
  try {
    await getAuthedClient().auth.signOut();
  } catch (err) {
    console.error('Sign out error:', err);
  }
}

// Restores a persisted session on app start; re-validates authorization.
export async function getCurrentUser(): Promise<AuthUser | null> {
  if (!isConfigured()) return null;
  try {
    const supabase = getAuthedClient();
    const { data } = await supabase.auth.getSession();
    const session = data.session;
    if (!session?.user) return null;

    const profile = await loadProfile(supabase, session.user.id);
    if (!profile || !profile.is_active) {
      await supabase.auth.signOut();
      return null;
    }
    return toAuthUser(session.user.id, session.user.email ?? '', profile);
  } catch {
    return null;
  }
}
