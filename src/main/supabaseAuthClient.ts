import { app, safeStorage } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config, isConfigured } from './config';

/**
 * supabaseAuthClient.ts
 * ---------------------------------------------------------------------------
 * Owns the SESSION-BEARING Supabase client — the one tied to whichever
 * operator is signed in — plus its encrypted-at-rest session storage.
 *
 * This is deliberately separate from supabaseClient.ts's client, which is
 * anon/session-less and used for order fetches that don't require a login.
 * Any RPC that resolves auth.uid() in Postgres (e.g. the sales report RPCs)
 * MUST be called on the client from here, not the anon one — auth.uid()
 * would otherwise be null and those RPCs treat that as "no access" (an
 * empty result, not an error), which is easy to misdiagnose.
 *
 * Higher-level auth flows (sign in/out, profile authorization) live in
 * authManager.ts, which imports getAuthedClient() from this file.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Persistent session storage, encrypted at rest with the OS keychain/DPAPI
// (Electron safeStorage). Falls back to plaintext only where encryption is
// not available (e.g. some Linux setups).
// ---------------------------------------------------------------------------
class EncryptedSessionStorage {
  private file = join(app.getPath('userData'), 'auth.session');

  getItem(_key: string): string | null {
    try {
      if (!existsSync(this.file)) return null;
      const buf = readFileSync(this.file);
      if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf);
      return buf.toString('utf8');
    } catch {
      return null;
    }
  }

  setItem(_key: string, value: string): void {
    try {
      const data = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(value)
        : Buffer.from(value, 'utf8');
      writeFileSync(this.file, data, { mode: 0o600 });
    } catch (err) {
      console.error('Failed to persist auth session:', err);
    }
  }

  removeItem(_key: string): void {
    try {
      if (existsSync(this.file)) unlinkSync(this.file);
    } catch {
      /* ignore */
    }
  }
}

let client: SupabaseClient | null = null;

/**
 * The session-bearing Supabase client (persisted, encrypted auth session,
 * auto-refreshing). Lazily created and cached as a singleton.
 */
export function getAuthedClient(): SupabaseClient {
  if (!isConfigured()) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.');
  }
  if (!client) {
    client = createClient(config.supabase.url, config.supabase.anonKey, {
      auth: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        storage: new EncryptedSessionStorage() as any,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}
