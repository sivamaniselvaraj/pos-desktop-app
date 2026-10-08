import { getAuthedClient } from './sessionClient';
import type { TaxRepository } from '../ports';

/** Every call is authorized (and scoped to the caller's outlet) in the database. */
export const tax: TaxRepository = {
  async list() {
    const { data, error } = await getAuthedClient().rpc('list_tax_rates');
    if (error) throw new Error(error.message);
    return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id ?? ''),
      categoryId: r.category_id ? String(r.category_id) : null,
      taxName: String(r.tax_name ?? ''),
      ratePercent: r.rate_percent == null ? null : Number(r.rate_percent),
      effectiveFrom: String(r.effective_from ?? ''),
      createdAt: String(r.created_at ?? ''),
      createdByName: r.created_by_name ? String(r.created_by_name) : undefined,
      state: (r.state as 'scheduled' | 'current' | 'past') ?? 'past',
    }));
  },

  async add(p) {
    const { error } = await getAuthedClient().rpc('add_tax_rate', {
      p_category: p.categoryId,
      p_name: p.taxName,
      p_rate: p.ratePercent,
      p_effective_local: p.effectiveLocal?.trim() || null,
    });
    if (error) throw new Error(error.message);
  },

  async remove(id) {
    const { error } = await getAuthedClient().rpc('delete_tax_rate', { p_id: id });
    if (error) throw new Error(error.message);
  },
};
