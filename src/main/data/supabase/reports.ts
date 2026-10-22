import { getAuthedClient } from './sessionClient';
import type { ReportRepository } from '../ports';
import type {
  ReportBucket,
  SalesReportRow,
  TopItemRow,
  SalesByOrderTypeRow,
  SalesByTypeBucketRow,
  SalesByWaiterRow,
  MenuAvailabilityReport,
} from '../../../shared/types';

/**
 * Settled orders for the signed-in user's outlet, aggregated by day or
 * month — one row per bucket, never per order. Empty array if not signed
 * in, no outlet assigned, or the role isn't manager/owner/admin — the RPC
 * enforces this server-side; the caller doesn't need to check separately.
 */
async function fetchSalesReport(
  from: string,
  to: string,
  bucket: ReportBucket = 'day',
): Promise<SalesReportRow[]> {
  const supabase = getAuthedClient();

  const { data, error } = await supabase.rpc('get_sales_report_uid', {
    p_from: from,
    p_to: to,
    p_bucket: bucket,
  });
  if (error) throw new Error(error.message);

  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    date: String(row.bucket_date ?? ''),
    orderCount: Number(row.order_count ?? 0),
    taxTotal: Number(row.tax_total ?? 0),
    netTotal: Number(row.net_total ?? 0),
    avgOrderValue: Number(row.avg_order_value ?? 0),
  }));
}

/**
 * Top-selling items (by quantity sold) for the signed-in user's outlet, in
 * the given date range. Same access rules as fetchSalesReport.
 */
async function fetchTopItems(
  from: string,
  to: string,
  limit = 10,
): Promise<TopItemRow[]> {
  const supabase = getAuthedClient();

  const { data, error } = await supabase.rpc('get_top_items', {
    p_from: from,
    p_to: to,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);

  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    menuItemId: String(row.menu_item_id ?? ''),
    name: String(row.name ?? 'Item'),
    quantitySold: Number(row.quantity_sold ?? 0),
    revenue: Number(row.revenue ?? 0),
  }));
}

/** Range totals per order type ('dine-in' | 'pickup' | 'delivery') — the summary stat cards. */
async function fetchSalesByOrderType(
  from: string,
  to: string,
): Promise<SalesByOrderTypeRow[]> {
  const supabase = getAuthedClient();

  const { data, error } = await supabase.rpc('get_sales_by_order_type', {
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(error.message);

  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    orderType: String(row.order_type ?? ''),
    orderCount: Number(row.order_count ?? 0),
  }));
}

/** Per-bucket order-type counts, pre-pivoted server-side — the grouped bar chart. */
async function fetchSalesByTypeBucketed(
  from: string,
  to: string,
  bucket: ReportBucket = 'day',
): Promise<SalesByTypeBucketRow[]> {
  const supabase = getAuthedClient();

  const { data, error } = await supabase.rpc('get_sales_by_type_bucketed', {
    p_from: from,
    p_to: to,
    p_bucket: bucket,
  });
  if (error) throw new Error(error.message);

  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    date: String(row.bucket_date ?? ''),
    dineInCount: Number(row.dine_in_count ?? 0),
    pickupCount: Number(row.pickup_count ?? 0),
    deliveryCount: Number(row.delivery_count ?? 0),
  }));
}

async function fetchSalesByWaiter(from: string, to: string): Promise<SalesByWaiterRow[]> {
  const { data, error } = await getAuthedClient().rpc('get_sales_by_waiter', { p_from: from, p_to: to });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    waiterId: r.waiter_id == null ? null : String(r.waiter_id),
    waiterName: String(r.waiter_name ?? ''),
    orderCount: Number(r.order_count ?? 0),
    invoiceCount: Number(r.invoice_count ?? 0),
    itemsSold: Number(r.items_sold ?? 0),
    subtotal: Number(r.subtotal ?? 0),
    discountTotal: Number(r.discount_total ?? 0),
    taxTotal: Number(r.tax_total ?? 0),
    salesExclTax: Number(r.sales_excl_tax ?? 0),
    totalSales: Number(r.total_sales ?? 0),
    avgOrderValue: Number(r.avg_order_value ?? 0),
    eligibleSales: Number(r.eligible_sales ?? 0),
    incentiveTotal: Number(r.incentive_total ?? 0),
  }));
}

async function fetchMenuAvailability(from: string, to: string): Promise<MenuAvailabilityReport> {
  const { data, error } = await getAuthedClient().rpc('get_menu_availability', { p_from: from, p_to: to });
  if (error) throw new Error(error.message);
  const d = (data ?? {}) as Record<string, unknown>;
  const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  const s = (d.summary ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (v == null ? null : String(v));
  return {
    summary: {
      offEvents: Number(s.off_events ?? 0),
      itemsAffected: Number(s.items_affected ?? 0),
      downtimeHours: Number(s.downtime_hours ?? 0),
      lostUnits: Number(s.lost_units ?? 0),
      lostValue: Number(s.lost_value ?? 0),
      categoryOffEvents: Number(s.category_off_events ?? 0),
      topReason: str(s.top_reason),
      currentlyOff: Number(s.currently_off ?? 0),
    },
    items: arr(d.items).map((r) => ({
      menuItemId: String(r.menu_item_id),
      name: String(r.name ?? ''),
      category: str(r.category),
      timesOff: Number(r.times_off ?? 0),
      downtimeHours: Number(r.downtime_hours ?? 0),
      longestHours: Number(r.longest_hours ?? 0),
      stillOff: r.still_off === true,
      topReason: str(r.top_reason),
      lostUnits: Number(r.lost_units ?? 0),
      lostValue: Number(r.lost_value ?? 0),
    })),
    reasons: arr(d.reasons).map((r) => ({
      reason: String(r.reason ?? ''),
      count: Number(r.count ?? 0),
      downtimeHours: Number(r.downtime_hours ?? 0),
    })),
    categoryEvents: arr(d.category_events).map((r) => ({
      categoryId: str(r.category_id),
      category: String(r.category ?? ''),
      offAt: String(r.off_at ?? ''),
      reason: String(r.reason ?? ''),
      itemCount: Number(r.item_count ?? 0),
      downtimeHours: Number(r.downtime_hours ?? 0),
      stillOff: r.still_off === true,
    })),
    timeline: arr(d.timeline).map((r) => ({
      menuItemId: String(r.menu_item_id),
      name: String(r.name ?? ''),
      category: str(r.category),
      offAt: String(r.off_at ?? ''),
      onAt: str(r.on_at),
      hours: Number(r.hours ?? 0),
      reason: String(r.reason ?? ''),
      by: str(r.by),
      scope: r.scope === 'category' ? 'category' : 'item',
    })),
    staff: arr(d.staff).map((r) => ({ name: String(r.name ?? ''), offs: Number(r.offs ?? 0), ons: Number(r.ons ?? 0) })),
    byWeekday: arr(d.by_weekday).map((r) => ({ dow: Number(r.dow), count: Number(r.count ?? 0) })),
    byHour: arr(d.by_hour).map((r) => ({ hour: Number(r.hour), count: Number(r.count ?? 0) })),
    currentlyOff: arr(d.currently_off).map((r) => ({
      menuItemId: String(r.menu_item_id),
      name: String(r.name ?? ''),
      category: str(r.category),
      reason: str(r.reason),
      since: str(r.since),
      by: str(r.by),
    })),
  };
}

export const reports: ReportRepository = {
  menuAvailability: fetchMenuAvailability,
  salesByWaiter: fetchSalesByWaiter,
  salesReport: fetchSalesReport,
  topItems: fetchTopItems,
  salesByOrderType: fetchSalesByOrderType,
  salesByTypeBucketed: fetchSalesByTypeBucketed,
};
