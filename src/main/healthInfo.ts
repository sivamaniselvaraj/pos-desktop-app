/**
 * healthInfo.ts
 * ---------------------------------------------------------------------------
 * The body of GET /api/health (docs/API.md). Kept free of Electron and the
 * data layer so it can be tested in plain Node (npm run test:api).
 *
 * Phones poll health every 10 s, so the outlet's display name is cached
 * (5 minutes, 30 s while it is missing) instead of read from the database on
 * every call. The read goes through db.auth.loadOutletName, which the offline
 * copy answers while the internet is down.
 * ---------------------------------------------------------------------------
 */

export const NAME_CACHE_MS = 5 * 60 * 1000;
export const NAME_RETRY_MS = 30 * 1000;

type Entry = { outletId: string; name: string | null; at: number };

/**
 * Returns a function that gives the outlet's display name (trimmed; null when
 * none). Never throws. Shares a read already running.
 */
export function createOutletNameCache(
  load: (outletId: string) => Promise<string | undefined>,
  now: () => number = Date.now,
): (outletId: string | null | undefined) => Promise<string | null> {
  let entry: Entry | null = null;
  let pending: { outletId: string; promise: Promise<string | null> } | null = null;

  return async (outletId) => {
    if (!outletId) return null;
    if (entry && entry.outletId === outletId) {
      const age = now() - entry.at;
      if (age < (entry.name === null ? NAME_RETRY_MS : NAME_CACHE_MS)) return entry.name;
    }
    if (pending && pending.outletId === outletId) return pending.promise;
    const promise = (async () => {
      let name: string | null = null;
      let ok = true;
      try {
        name = (await load(outletId))?.trim() || null;
      } catch {
        ok = false;
      }
      // A failed read keeps an older name for this outlet rather than dropping it.
      if (!ok && entry && entry.outletId === outletId && entry.name !== null) {
        entry = { ...entry, at: now() - NAME_CACHE_MS + NAME_RETRY_MS };
        return entry.name;
      }
      entry = { outletId, name, at: now() };
      return name;
    })().finally(() => {
      pending = null;
    });
    pending = { outletId, promise };
    return promise;
  };
}

export interface HealthDeps {
  /** The installed desktop app's version (app.getVersion(), from package.json). */
  appVersion: string;
  hasValidToken: boolean;
  isDatabaseConnected: () => Promise<boolean>;
  restaurantName: () => Promise<string | null>;
  now?: () => Date;
}

/** GET /api/health: database, mode and restaurantName only for a caller holding a valid device token. */
export async function buildHealthBody(deps: HealthDeps): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    status: 'ok',
    timestamp: (deps.now ? deps.now() : new Date()).toISOString(),
    version: deps.appVersion,
  };
  if (deps.hasValidToken) {
    const [connected, name] = await Promise.all([deps.isDatabaseConnected(), deps.restaurantName()]);
    body.database = connected ? 'connected' : 'disconnected';
    // Offline mode: the desktop answers from this computer's copy while the internet is down.
    body.mode = connected ? 'online' : 'offline';
    // The outlet's display name; null when it has none (or it could not be read yet).
    body.restaurantName = name;
  }
  return body;
}
