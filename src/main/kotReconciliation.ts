import { getAuthedClient } from './supabaseAuthClient';
import { orderManager } from './orderManager';
import { printQueue } from './printQueue';

/**
 * kotReconciliation.ts
 * ---------------------------------------------------------------------------
 * Catches the one real gap the in-memory printQueue can't cover on its own:
 * if the app crashes or is force-quit while a KOT job is still queued (or
 * before Android's confirm request even reaches it — e.g. the app was down
 * when the request was sent and it simply failed), that job is gone. Nothing
 * about the ORDER is lost — order_items.kot_printed only flips to true after
 * a successful print, so an interrupted order just sits there with
 * unprinted items, exactly as if it had never been confirmed. This module's
 * only job is to notice that state and finish the job on a timer.
 *
 * Runs once on startup, then every 30 seconds. Each discovered order is
 * processed through the EXACT SAME path a normal Android confirm request
 * uses — orderManager.handleIncoming(orderId, 'kot'), routed through the
 * same shared printQueue as the HTTP endpoint and the Orders List's
 * Print/Reprint action — so a reconciled order can never race a live
 * request for physical access to the printer.
 *
 * Constraint worth knowing: discovering WHICH orders need attention requires
 * resolving an outlet, and this app has no outlet binding independent of a
 * logged-in user (see the "#4 seam" noted elsewhere in this codebase). So
 * reconciliation only does anything while someone is signed in. If no
 * session exists, a cycle just no-ops and tries again in 30s — nothing is
 * lost while waiting, since kot_printed stays false in the database exactly
 * as it already would either way.
 * ---------------------------------------------------------------------------
 */

const RECONCILE_INTERVAL_MS = 30_000;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let running = false; // guards against a slow cycle overlapping the next tick

export async function reconcilePendingKots(): Promise<void> {
  if (running) return; // previous cycle still in flight — skip this tick rather than pile up
  running = true;

  try {
    const supabase = getAuthedClient();
    const { data, error } = await supabase.rpc('find_orders_with_pending_kot');

    if (error) {
      console.error('[kotReconciliation] Discovery query failed:', error.message);
      return;
    }

    const rows = (data ?? []) as { order_id: string; order_type: string }[];
    if (rows.length === 0) return; // the common case — nothing to log every 30s

    console.log(
      `[kotReconciliation] Found ${rows.length} order(s) with unprinted kitchen items — reconciling.`,
    );

    for (const row of rows) {
      try {
        // Same queue as every other print entry point — never a direct call.
        const result = await printQueue.enqueue(() =>
          orderManager.handleIncoming(row.order_id, 'kot'),
        );
        if (result.success) {
          console.log(`[kotReconciliation] Order ${row.order_id}: ${result.message}`);
        } else {
          console.error(`[kotReconciliation] Order ${row.order_id}: ${result.message}`);
        }
      } catch (err) {
        // One bad order must not stop the rest of this cycle's list.
        console.error(
          `[kotReconciliation] Order ${row.order_id} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } catch (err) {
    // Expected during early startup (Supabase not configured yet) or while
    // logged out — not an error worth alarming about, just skip this cycle.
    console.log(
      '[kotReconciliation] Skipped this cycle:',
      err instanceof Error ? err.message : err,
    );
  } finally {
    running = false;
  }
}

/** Call once during app startup. Runs immediately, then every 30 seconds. */
export function startKotReconciliation(): void {
  void reconcilePendingKots();

  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(() => {
    void reconcilePendingKots();
  }, RECONCILE_INTERVAL_MS);
}

/** Call on app shutdown so the interval doesn't keep firing during quit. */
export function stopKotReconciliation(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
