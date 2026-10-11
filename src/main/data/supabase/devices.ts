import { createClient } from '@supabase/supabase-js';
import { getAuthedClient } from './sessionClient';
import { supabaseSettings } from './settings';
import type { DevicePairingRepository } from '../ports';

export const devices: DevicePairingRepository = {
  async resolveOwner(accessToken) {
    if (!supabaseSettings.url || !supabaseSettings.anonKey) throw new Error('Database is not configured.');
    // A throwaway client that acts as the phone's user, so the database says who they are.
    const asPhoneUser = createClient(supabaseSettings.url, supabaseSettings.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const { data, error } = await asPhoneUser.rpc('get_device_owner');
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
