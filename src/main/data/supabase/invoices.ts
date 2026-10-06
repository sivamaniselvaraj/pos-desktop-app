import { getAuthedClient } from './sessionClient';
import type { InvoiceRepository } from '../ports';

export const invoices: InvoiceRepository = {
  async getSequenceStatus() {
    const { data, error } = await getAuthedClient().rpc('get_invoice_sequence_status');
    if (error) throw new Error(error.message);
    // Not an admin (or no profile/outlet): zero rows rather than an error.
    const row = ((data ?? []) as Record<string, unknown>[])[0];
    if (!row) return null;
    return {
      outletId: String(row.outlet_id ?? ''),
      currentSeq: Number(row.current_seq ?? 0),
      lastResetAt: row.last_reset_at ? String(row.last_reset_at) : null,
      resetByName: row.reset_by_name ? String(row.reset_by_name) : undefined,
    };
  },

  async resetSequence() {
    const { error } = await getAuthedClient().rpc('reset_invoice_sequence');
    if (error) throw new Error(error.message);
  },
};
