import { config } from './config';
import { fetchMenuItemsForOutlet } from './supabaseClient';

/**
 * menuCache.ts
 * ---------------------------------------------------------------------------
 * Holds this machine's outlet's menu in memory. Populated from Supabase via
 * refreshMenuCache() (on startup, on a timer, and via a manual "Refresh"
 * button on the Menu page); every other read — including the HTTP endpoint
 * Android calls — reads the in-memory array directly, with no Supabase call
 * on the request path at all. That's the actual point of this file: turning
 * "every menu fetch is a DB round trip" into "one DB round trip populates
 * memory, everything else is instant."
 *
 * Each cached item is a raw JSON object (whatever get_menu_items_for_outlet
 * returns via to_jsonb) rather than a typed MenuItem — this project has
 * never confirmed menu_items' real columns beyond id/name, so this
 * deliberately doesn't assume a fixed shape. See that RPC's comment in
 * db/functions.sql for why.
 * ---------------------------------------------------------------------------
 */

export interface MenuCacheState {
  items: Record<string, unknown>[];
  lastRefreshedAt: string | null;
  lastError: string | null;
}

let items: Record<string, unknown>[] = [];
let lastRefreshedAt: string | null = null;
let lastError: string | null = null;

const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 5 minutes — menu changes are rare, unlike KOT tickets
let intervalHandle: ReturnType<typeof setInterval> | null = null;

/** Current cache contents — synchronous, no network/DB call. */
export function getCachedMenuItems(): MenuCacheState {
  return { items, lastRefreshedAt, lastError };
}

/**
 * Re-fetches this machine's outlet's menu from Supabase and replaces the
 * in-memory cache. Uses the anon client — get_menu_items_for_outlet() is
 * deliberately not login-gated (see its comment in db/functions.sql), since
 * this has to work all day regardless of whether anyone's signed into the
 * desktop UI.
 */
export async function refreshMenuCache(): Promise<MenuCacheState> {
  if (!config.outletId) {
    lastError = 'OUTLET_ID is not configured for this machine — set it in .env.local.';
    console.error(`[menuCache] ${lastError}`);
    return getCachedMenuItems();
  }
  if (!config.supabase.url || !config.supabase.anonKey) {
    lastError = 'Supabase is not configured.';
    console.error(`[menuCache] ${lastError}`);
    return getCachedMenuItems();
  }
try {

    items = await fetchMenuItemsForOutlet(config.outletId);
    lastRefreshedAt = new Date().toISOString();
    lastError = null;
    console.log(`[menuCache] Refreshed — ${items.length} item(s) cached.`);
  } catch (err) {
    lastError = err instanceof Error ? err.message : 'Unknown error refreshing menu cache';
    console.error('[menuCache] Refresh failed:', lastError);
    // Deliberately keep serving the STALE cache rather than clearing it —
    // a stale menu is far better for Android than no menu at all.
  }
  
  return getCachedMenuItems();
}

/** Call once during app startup. Refreshes immediately, then every 5 minutes. */
export function startMenuCache(): void {
  void refreshMenuCache();

  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(() => {
    void refreshMenuCache();
  }, REFRESH_INTERVAL_MS);
}

/** Call on app shutdown so the interval doesn't keep firing during quit. */
export function stopMenuCache(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
