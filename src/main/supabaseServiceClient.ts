import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from './config';

/**
 * supabaseServiceClient.ts
 * ---------------------------------------------------------------------------
 * The service_role Supabase client. This key BYPASSES Row Level Security
 * entirely — it is not "just another client," it is full, unrestricted
 * database access.
 *
 * Used for exactly one thing: userAdmin.ts's createUser(), because creating
 * a login (setting a password) requires Supabase's Auth Admin API, and that
 * API only works with this key. There is no RLS-safe alternative — Supabase
 * does not expose user creation through PostgREST/RPC.
 *
 * Because RLS provides no protection on this client, every call site MUST
 * verify the caller is actually an admin via the normal session client
 * (getAuthedClient() + is_admin() RPC) BEFORE using this one. See
 * userAdmin.ts's assertCallerIsAdmin().
 *
 * This key lives in .env.local on whichever machine runs the desktop app —
 * treat that machine as trusted/admin-only, the same way KITCHEN_PRINTER
 * config already is. Never expose this client to the renderer process.
 * ---------------------------------------------------------------------------
 */

let client: SupabaseClient | null = null;

export function getServiceClient(): SupabaseClient {
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not configured. Creating users requires it — set it in .env.local.',
    );
  }
  if (!client) {
    client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
