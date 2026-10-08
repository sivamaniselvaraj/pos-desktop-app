import { config } from './config';
import { db } from './data';

/**
 * menuCache.ts
 * ---------------------------------------------------------------------------
 * Holds this machine's outlet's menu in memory. Populated from the database (db.menu) via
 * refreshMenuCache() (on startup, on a timer, and via a manual "Refresh"
 * button on the Menu page); every other read — including the HTTP endpoint
 * Android calls — reads the in-memory array directly, with no database call
 * on the request path at all. That's the actual point of this file: turning
 * "every menu fetch is a DB round trip" into "one DB round trip populates
 * memory, everything else is instant."
 *
 * Each cached item is a raw JSON object (whatever the provider returns) rather than a typed MenuItem — this project has
 * never confirmed menu_items' real columns beyond id/name, so this
 * deliberately doesn't assume a fixed shape. 
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
 * Re-fetches this machine's outlet's menu from the database and replaces the
 * in-memory cache. Needs no signed-in user (db.menu.fetchMenu), since
 * this has to work all day regardless of whether anyone's signed into the
 * desktop UI.
 */
export async function refreshMenuCache(): Promise<MenuCacheState> {
  if (!config.outletId) {
    lastError = 'OUTLET_ID is not configured for this machine — set it in .env.local.';
    console.error(`[menuCache] ${lastError}`);
    return getCachedMenuItems();
  }
  if (!db.isConfigured()) {
    lastError = 'The database is not configured.';
    console.error(`[menuCache] ${lastError}`);
    return getCachedMenuItems();
  }

try {
    items = await db.menu.fetchMenu(config.outletId);
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

/**
 * Toggle a menu item on/off — the "item ran out" use case. Admin-gated
 * write, so this uses the SESSION client (getAuthedClient), unlike
 * refreshMenuCache's anon-client read above. Immediately re-refreshes the
 * cache on success so Android sees the change right away rather than
 * waiting up to 5 minutes for the next scheduled refresh — that delay would
 * defeat the entire point of an "it just ran out, take it off now" toggle.
 */
export async function setMenuItemActive(
  menuItemId: string,
  isActive: boolean,
): Promise<MenuCacheState> {
  await db.menu.setItemActive(menuItemId, isActive);

  return refreshMenuCache();
}

/** Turn a whole category on or off ("the whole category ran out"), then refresh the cache for Android. */
export async function setCategoryActive(categoryId: string, isActive: boolean): Promise<MenuCacheState> {
  if (!config.outletId) throw new Error('OUTLET_ID is not configured for this machine.');
  await db.menu.setCategoryActive(config.outletId, categoryId || null, isActive);
  return refreshMenuCache();
}

/** Drops the cached menu (used when a runtime-bound outlet signs out, so the next user never sees it). */
export function clearMenuCache(): void {
  items = [];
  lastRefreshedAt = null;
  lastError = null;
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
