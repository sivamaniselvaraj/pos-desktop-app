import type { OrderItem } from '../../shared/types';

/**
 * Merges repeat lines of the same dish into one (2 + 3 Kulcha -> 5). unit_price
 * is stable per day, so menuItemId alone is a safe merge key; falls back to
 * the item name when the id is absent. Pure: any provider can reuse it.
 */
export function aggregateItems(rows: OrderItem[]): OrderItem[] {
  const merged = new Map<string, OrderItem>();
  for (const item of rows) {
    const key = item.menuItemId ?? `name:${item.name}`;
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      merged.set(key, { ...item });
    }
  }
  return Array.from(merged.values());
}

/** Dashboard card state from the table's latest order status. Pure: any provider can reuse it. */
export function deriveCardStatus(orderStatus: string | undefined): 'available' | 'settled' | 'active' {
  if (!orderStatus || orderStatus === 'cancelled') return 'available';
  if (orderStatus === 'completed') return 'settled';
  return 'active'; // 'open'
}
