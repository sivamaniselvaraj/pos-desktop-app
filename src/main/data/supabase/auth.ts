import { getAuthedClient } from './sessionClient';
import type { AuthRepository, UserProfile } from '../ports';

export const auth: AuthRepository = {
  async signIn(email, password) {
    const { data, error } = await getAuthedClient().auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: error.message };
    if (!data.user) return { ok: false, error: 'Authentication failed.' };
    return { ok: true, user: { id: data.user.id, email: data.user.email ?? email } };
  },

  async signOut() {
    await getAuthedClient().auth.signOut();
  },

  async getSessionUser() {
    const { data } = await getAuthedClient().auth.getSession();
    const user = data.session?.user;
    return user ? { id: user.id, email: user.email ?? '' } : null;
  },

  // Reads the signed-in user's own profile (allowed by RLS "read own profile").
  async loadProfile(userId): Promise<UserProfile | null> {
    const { data, error } = await getAuthedClient()
      .from('profiles')
      .select('user_id, email, first_name, role, is_active, outlet_id')
      .eq('user_id', userId)
      .single();
    if (error || !data) return null;  
    const r = data as Record<string, unknown>;
    return {
      id: String(r.id),
      email: (r.email as string | null) ?? null,
      fullName: (r.first_name as string | null) ?? null,
      role: (r.role as string | null) ?? null,
      isActive: (r.is_active as boolean | null) ?? null,
      outletId: (r.outlet_id as string | null) ?? null,
    };
  },

  // Separate query rather than a nested select (profiles -> outlets): works
  // regardless of whether PostgREST can infer that relationship, and a lookup
  // failure only leaves the name unset.
  async loadOutletName(outletId) {
    const { data, error } = await getAuthedClient().from('outlets').select('name').eq('id', outletId).single();
    if (error || !data) return undefined;
    return (data as { name: string | null }).name ?? undefined;
  },
};
