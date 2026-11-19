/**
 * Kitchen note on one order line ("no onion"), printed under the dish on the KOT.
 * Stored in order_items.special_instructions. The database also trims it and
 * cuts it to ITEM_NOTE_MAX, so older or other clients cannot store more.
 */
export const ITEM_NOTE_MAX = 200;

/** Line breaks and other control characters become one space; trimmed; cut to ITEM_NOTE_MAX. Empty -> undefined. */
export function cleanItemNote(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, ITEM_NOTE_MAX)
    .trim();
  return t || undefined;
}
