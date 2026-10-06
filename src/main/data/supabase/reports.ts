import { getAuthedClient } from './sessionClient';
import type { ReportRepository } from '../ports';
import type {
  ReportBucket,
  SalesReportRow,
  TopItemRow,
  SalesByOrderTypeRow,
  SalesByTypeBucketRow,
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

export const reports: ReportRepository = {
  salesReport: fetchSalesReport,
  topItems: fetchTopItems,
  salesByOrderType: fetchSalesByOrderType,
  salesByTypeBucketed: fetchSalesByTypeBucketed,
};
