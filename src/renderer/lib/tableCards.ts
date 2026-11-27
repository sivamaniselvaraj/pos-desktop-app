import type { TableCard } from '@shared/types';

/**
 * Dashboard Dine-in tab helpers (docs/DASHBOARD_TABLES.md). No React here, so
 * the live-update reuse can be tested in plain Node (tests/live/tableCards.test.ts).
 */

/** One tile per bill: a table can show a printed bill and a running bill (docs/TABLE_BILLS.md). */
export function cardKey(t: TableCard): string {
  return `${t.tableId}:${t.invoiceNumber ?? t.orderId ?? ''}`;
}

function sameList<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** True when every field a tile shows (or acts on) is the same. */
export function sameCard(a: TableCard, b: TableCard): boolean {
  return (
    a.tableId === b.tableId &&
    a.tableNumber === b.tableNumber &&
    a.invoiceNumber === b.invoiceNumber &&
    a.orderId === b.orderId &&
    a.orderStatus === b.orderStatus &&
    a.orderCreatedAt === b.orderCreatedAt &&
    a.orderTotalAmount === b.orderTotalAmount &&
    a.orderDiscountAmount === b.orderDiscountAmount &&
    a.cardStatus === b.cardStatus &&
    a.paymentRecorded === b.paymentRecorded &&
    a.floor === b.floor &&
    a.capacity === b.capacity &&
    sameList(a.orderIds, b.orderIds) &&
    sameList(a.orderNumbers, b.orderNumbers)
  );
}

/**
 * Live updates and quiet reloads: keep the old object for every tile that did
 * not change, so its memoized tile does not re-render (no flicker). When
 * nothing changed at all (same tiles, same order) the old array itself is
 * returned and React skips the render.
 */
export function reuseUnchangedCards(prev: TableCard[], next: TableCard[]): TableCard[] {
  if (prev.length === 0) return next;
  const old = new Map<string, TableCard>();
  for (const t of prev) old.set(cardKey(t), t);
  let allSame = prev.length === next.length;
  const merged = next.map((t, i) => {
    const o = old.get(cardKey(t));
    const keep = o && sameCard(o, t) ? o : t;
    if (allSame && keep !== prev[i]) allSame = false;
    return keep;
  });
  return allSame ? prev : merged;
}
