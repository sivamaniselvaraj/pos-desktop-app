import { createClient } from '@supabase/supabase-js';
import { getAuthedClient } from './sessionClient';
import { supabaseSettings } from './settings';
import type { DevicePairingRepository } from '../ports';

/** A throwaway client (nothing stored). With a token it acts as that user, so the database says who they are. */
function throwawayClient(accessToken?: string) {
  if (!supabaseSettings.url || !supabaseSettings.anonKey) throw new Error('Database is not configured.');
  return createClient(supabaseSettings.url, supabaseSettings.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

export const devices: DevicePairingRepository = {
  async resolveOwner(accessToken) {
    const { data, error } = await throwawayClient(accessToken).rpc('get_device_owner');
    if (error || !data || typeof data !== 'object') return null;
    const d = data as { user_id?: string; name?: string; outlet_id?: string | null; is_active?: boolean };
    if (!d.user_id) return null;
    return {
      userId: String(d.user_id),
      name: String(d.name ?? 'User'),
      outletId: d.outlet_id ? String(d.outlet_id) : null,
      isActive: d.is_active !== false,
    };
  },

  // Email + password -> access token, then the SAME owner lookup the token flow uses.
  async signInAsUser(email, password) {
    const { data, error } = await throwawayClient().auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      // A wrong email/password is a normal answer; anything else (network, server) is an error.
      if (error && (error.status === undefined || error.status >= 500)) throw new Error('The sign-in service is not reachable.');
      return null;
    }
    return devices.resolveOwner(data.session.access_token);
  },

  async ownerStatus(userIds) {
    if (userIds.length === 0) return [];
    const { data, error } = await getAuthedClient().rpc('device_owner_status', { p_user_ids: userIds });
    if (error) throw new Error(error.message);
    return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      userId: String(r.user_id),
      isActive: Boolean(r.is_active),
      inOutlet: Boolean(r.in_outlet),
    }));
  },
};
