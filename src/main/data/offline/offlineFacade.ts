/**
 * data/offline/offlineFacade.ts
 * ---------------------------------------------------------------------------
 * Wraps the cloud provider's repositories so the managers keep calling
 * `db.*` exactly as before, and:
 *
 *  - Reference reads (MIRRORED below) are saved in the local database each
 *    time they succeed (only when the answer changed, by hash). When the
 *    database cannot be reached they are answered from that copy.
 *  - Every other call (writes, orders, reports) still goes to the database.
 *    When it fails because the connection is down it fails fast with one
 *    clear message instead of a raw network error.
 *
 * Online, reads go to the database first (with a time limit), so a change
 * made on another computer shows at once; the local copy is the fallback.
 * Offline (two failed health checks), mirrored reads do not wait for the
 * network at all.
 *
 * Copies are kept per outlet (the local file is bound to one outlet) and, for
 * answers that depend on who is signed in, per user: a user never gets
 * another user's permissions from the copy.
 * ---------------------------------------------------------------------------
 */
import type { ConnectivityMonitor } from './connectivity';
import { withTimeout } from './connectivity';
import type { LocalStore } from './localStore';

/** shared: the same for everyone in the outlet. user: depends on the signed-in user (permissions). */
export interface MirrorRule {
  scope: 'shared' | 'user';
  /** The provider returns null/undefined instead of throwing when it fails (e.g. loadProfile). */
  emptyIsFailure?: boolean;
}

/** Tier A reads (docs/OFFLINE_MODE.md section 3) kept in the local database. */
export const MIRRORED: Record<string, Record<string, MirrorRule>> = {
  auth: {
    loadProfile: { scope: 'shared', emptyIsFailure: true }, // keyed by the user id argument
    loadOutletName: { scope: 'shared', emptyIsFailure: true },
  },
  access: {
    fetchMyAccess: { scope: 'user', emptyIsFailure: true },
    getReceiptText: { scope: 'shared' },
  },
  orders: {
    fetchOutletById: { scope: 'shared' },
  },
  orderAdmin: {
    listKotSetup: { scope: 'user' },
    getDiscountSettings: { scope: 'user' },
    getDiscountOptions: { scope: 'user' },
  },
  orderEntry: {
    getTaxRates: { scope: 'user' },
  },
  tax: {
    list: { scope: 'user' },
  },
  kots: {
    getWorkflow: { scope: 'user' },
  },
  remoteOrders: {
    getKotSettings: { scope: 'user' },
  },
  tables: {
    listTableNumbers: { scope: 'shared' },
  },
  menu: {
    fetchMenu: { scope: 'shared' },
    listCategories: { scope: 'user' },
  },
};

/** Never wrapped: the health check itself. */
const PASS_THROUGH = new Set(['orders.isReachable']);

/** How long an online read may take before the local copy is tried. */
export const READ_TIMEOUT_MS = 8_000;

export const OFFLINE_MESSAGE = 'No internet connection. This needs the database; try again when the connection is back.';
export const NOT_SAVED_MESSAGE =
  'No internet connection, and this has not been saved on this computer yet. Try again when the connection is back.';

export const SIGN_IN_OFFLINE_MESSAGE =
  'No internet connection. Signing in needs the internet in this version; try again when the connection is back.';

export class OfflineError extends Error {
  readonly offline = true;
}

export interface OfflineFacadeDeps {
  monitor: ConnectivityMonitor;
  /** The local database, or null when it is not available (not started, native module missing). */
  getStore: () => LocalStore | null;
  /** This computer's outlet ('' when not known yet). */
  getOutletId: () => string;
  readTimeoutMs?: number;
  log?: (msg: string) => void;
}

export function snapshotKey(repo: string, method: string, scope: string, args: unknown[]): string {
  return `${repo}.${method}|${scope}|${JSON.stringify(args)}`;
}

type AnyFn = (...args: unknown[]) => unknown;

export class OfflineFacade {
  private currentUserId: string | null = null;
  private wrapped = new WeakMap<object, object>();
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: OfflineFacadeDeps) {
    this.log = deps.log ?? ((m) => console.log(`[offline] ${m}`));
  }

  setCurrentUser(userId: string | null): void {
    this.currentUserId = userId;
  }

  get currentUser(): string | null {
    return this.currentUserId;
  }

  /** The repository with every method wrapped (cached per repository object). */
  wrap<T extends object>(repoName: string, repo: T): T {
    const cached = this.wrapped.get(repo);
    if (cached) return cached as T;
    const out: Record<string, unknown> = {};
    for (const [method, value] of Object.entries(repo)) {
      if (typeof value !== 'function') {
        out[method] = value;
        continue;
      }
      const fn = (value as AnyFn).bind(repo);
      const id = `${repoName}.${method}`;
      if (PASS_THROUGH.has(id)) out[method] = fn;
      else if (MIRRORED[repoName]?.[method]) out[method] = this.mirrored(repoName, method, MIRRORED[repoName][method], fn);
      else out[method] = this.guarded(fn);
    }
    if (repoName === 'auth') this.trackUser(out);
    this.wrapped.set(repo, out);
    return out as T;
  }

  /** Remembers who is signed in, for user-scoped copies. */
  private trackUser(auth: Record<string, unknown>): void {
    const signIn = auth.signIn as AnyFn;
    const signOut = auth.signOut as AnyFn;
    const getSessionUser = auth.getSessionUser as AnyFn;
    auth.signIn = async (...args: unknown[]) => {
      const res = (await signIn(...args)) as { ok: boolean; user?: { id: string }; error?: string };
      if (res?.ok && res.user) this.currentUserId = res.user.id;
      else if (res && !res.ok && !(await this.deps.monitor.checkNow(true))) {
        // The provider reports a network failure as a sign-in error; say what it is.
        return { ok: false, error: SIGN_IN_OFFLINE_MESSAGE };
      }
      return res;
    };
    auth.signOut = async (...args: unknown[]) => {
      this.currentUserId = null;
      return signOut(...args);
    };
    auth.getSessionUser = async (...args: unknown[]) => {
      const user = (await getSessionUser(...args)) as { id: string } | null;
      this.currentUserId = user?.id ?? null;
      return user;
    };
  }

  /** Not mirrored: always the database; a failure while the connection is down gets the clear message. */
  private guarded(fn: AnyFn): AnyFn {
    return async (...args: unknown[]) => {
      try {
        return await fn(...args);
      } catch (err) {
        if (err instanceof OfflineError) throw err;
        const reachable = await this.deps.monitor.checkNow(true);
        if (!reachable) throw new OfflineError(OFFLINE_MESSAGE);
        throw err;
      }
    };
  }

  private mirrored(repo: string, method: string, rule: MirrorRule, fn: AnyFn): AnyFn {
    return async (...args: unknown[]) => {
      const store = this.deps.getStore();
      const outlet = this.deps.getOutletId();
      const scope = rule.scope === 'shared' ? 'shared' : this.currentUserId ? `user:${this.currentUserId}` : null;
      const usable = store !== null && Boolean(outlet) && scope !== null;
      const key = scope ? snapshotKey(repo, method, scope, args) : '';

      const fromCopy = (): unknown => {
        const snap = usable ? store!.getSnapshot(outlet, key) : null;
        if (!snap) throw new OfflineError(NOT_SAVED_MESSAGE);
        return snap.payload;
      };

      if (usable && this.deps.monitor.isOffline()) return fromCopy();

      let result: unknown;
      try {
        result = await withTimeout(
          Promise.resolve(fn(...args)),
          this.deps.readTimeoutMs ?? READ_TIMEOUT_MS,
          'The database did not answer in time.',
        );
      } catch (err) {
        if (await this.deps.monitor.checkNow(true)) throw err; // the database is there: a real error
        if (!usable) throw new OfflineError(OFFLINE_MESSAGE);
        this.log(`${repo}.${method}: database unreachable, answered from this computer's copy`);
        return fromCopy();
      }

      if (rule.emptyIsFailure && result == null) {
        // The provider hides its errors as "nothing": only the health check can tell.
        // Offline with no copy: throw rather than answer "nothing", so a caller
        // never takes the empty answer as real (e.g. signs the user out for "no profile").
        if (!(await this.deps.monitor.checkNow(true))) return fromCopy();
        return result;
      }

      if (usable) {
        try {
          store!.putSnapshot(outlet, key, { repo, method, scope: scope! }, result);
        } catch (err) {
          // The copy is a safety net: failing to save it must never fail the read.
          this.log(`could not save ${repo}.${method} locally: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return result;
    };
  }
}
