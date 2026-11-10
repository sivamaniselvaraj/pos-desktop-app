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
  ShiftWindow,
  DailySummaryReport,
  HourlySalesReport,
  ProductMixReport,
  ChannelSalesReport,
  VoidsDiscountsReport,
  VoidEventKind,
} from '../../../shared/reportTypes';

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

const VOID_KINDS: VoidEventKind[] = [
  'item_removed', 'qty_reduced', 'order_cancelled', 'kitchen_cancelled', 'discount', 'complimentary', 'discount_removed',
];

async function fetchVoidsDiscounts(from: string, to: string): Promise<VoidsDiscountsReport> {
  const { data, error } = await getAuthedClient().rpc('get_voids_discounts', { p_from: from, p_to: to });
  if (error) throw new Error(error.message);
  const d = (data ?? {}) as Record<string, unknown>;
  const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  const s = (d.summary ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
  const num = (v: unknown): number => Number(v ?? 0) || 0;
  return {
    summary: {
      events: num(s.events),
      voidCount: num(s.void_count),
      voidQty: num(s.void_qty),
      voidValue: num(s.void_value),
      kitchenCancelCount: num(s.kitchen_cancel_count),
      kitchenCancelValue: num(s.kitchen_cancel_value),
      cancelledOrders: num(s.cancelled_orders),
      cancelledValue: num(s.cancelled_value),
      discountOrders: num(s.discount_orders),
      discountValue: num(s.discount_value),
      complimentaryOrders: num(s.complimentary_orders),
      complimentaryValue: num(s.complimentary_value),
      noReason: num(s.no_reason),
    },
    events: arr(d.events).map((r) => ({
      id: String(r.id ?? ''),
      at: String(r.at ?? ''),
      kind: (VOID_KINDS as string[]).includes(String(r.kind)) ? (r.kind as VoidEventKind) : 'item_removed',
      orderId: String(r.order_id ?? ''),
      orderNumber: r.order_number == null ? null : Number(r.order_number),
      invoiceNumber: str(r.invoice_number),
      orderType: String(r.order_type ?? ''),
      orderStatus: String(r.order_status ?? ''),
      tableNumber: str(r.table_number),
      item: str(r.item),
      qty: r.qty == null ? null : Number(r.qty),
      value: num(r.value),
      detail: str(r.detail),
      reason: str(r.reason),
      by: String(r.by ?? 'Unknown'),
      approvedBy: str(r.approved_by),
    })),
    staff: arr(d.staff).map((r) => ({
      name: String(r.name ?? ''),
      voids: num(r.voids),
      voidValue: num(r.void_value),
      cancels: num(r.cancels),
      cancelValue: num(r.cancel_value),
      discounts: num(r.discounts),
      discountValue: num(r.discount_value),
      totalValue: num(r.total_value),
    })),
    reasons: arr(d.reasons).map((r) => ({ reason: String(r.reason ?? ''), count: num(r.count), value: num(r.value) })),
  };
}

// ---- Sales and revenue reports (docs/SALES_REPORTS.md) ----

type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const num = (v: unknown): number => Number(v ?? 0) || 0;
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));

async function callJson(fn: string, args: Record<string, unknown>): Promise<Row> {
  const { data, error } = await getAuthedClient().rpc(fn, args);
  if (error) throw new Error(error.message);
  return (data ?? {}) as Row;
}

async function fetchDailySummary(from: string, to: string, shift: ShiftWindow | null): Promise<DailySummaryReport> {
  const d = await callJson('get_daily_summary', {
    p_from: from,
    p_to: to,
    p_shift_start: shift ? shift.start : null,
    p_shift_end: shift ? shift.end : null,
  });
  const s = (d.summary ?? {}) as Row;
  return {
    summary: {
      orders: num(s.orders),
      invoices: num(s.invoices),
      itemsSold: num(s.items_sold),
      grossSales: num(s.gross_sales),
      discounts: num(s.discounts),
      discountOrders: num(s.discount_orders),
      complimentary: num(s.complimentary),
      complimentaryOrders: num(s.complimentary_orders),
      netSales: num(s.net_sales),
      containerCharges: num(s.container_charges),
      tax: num(s.tax),
      total: num(s.total),
      avgOrderValue: num(s.avg_order_value),
      avgBillValue: num(s.avg_bill_value),
      firstOrderAt: strOrNull(s.first_order_at),
      lastOrderAt: strOrNull(s.last_order_at),
      cancelledOrders: num(s.cancelled_orders),
      cancelledValue: num(s.cancelled_value),
    },
    taxLines: rows(d.tax_lines).map((r) => ({
      name: String(r.name ?? 'Tax'),
      rate: r.rate == null ? null : num(r.rate),
      taxable: num(r.taxable),
      tax: num(r.tax),
    })),
    payments: rows(d.payments).map((r) => ({ method: String(r.method ?? ''), orders: num(r.orders), amount: num(r.amount) })),
    orderTypes: rows(d.order_types).map((r) => ({
      orderType: String(r.order_type ?? ''),
      orders: num(r.orders),
      netSales: num(r.net_sales),
      total: num(r.total),
    })),
    days: rows(d.days).map((r) => ({
      date: String(r.date ?? ''),
      orders: num(r.orders),
      grossSales: num(r.gross_sales),
      discounts: num(r.discounts),
      netSales: num(r.net_sales),
      tax: num(r.tax),
      total: num(r.total),
    })),
  };
}

async function fetchSalesByHour(from: string, to: string): Promise<HourlySalesReport> {
  const d = await callJson('get_sales_by_hour', { p_from: from, p_to: to });
  return {
    cells: rows(d.cells).map((r) => ({
      dow: num(r.dow),
      hour: num(r.hour),
      orders: num(r.orders),
      itemsSold: num(r.items_sold),
      netSales: num(r.net_sales),
      total: num(r.total),
    })),
    days: rows(d.days).map((r) => ({ dow: num(r.dow), days: num(r.days), daysOpen: num(r.days_open) })),
  };
}

async function fetchProductMix(from: string, to: string): Promise<ProductMixReport> {
  const d = await callJson('get_product_mix', { p_from: from, p_to: to });
  const t = (d.totals ?? {}) as Row;
  return {
    items: rows(d.items).map((r) => ({
      menuItemId: strOrNull(r.menu_item_id),
      name: String(r.name ?? 'Item'),
      category: String(r.category ?? 'Uncategorised'),
      isActive: r.is_active !== false,
      qty: num(r.qty),
      netSales: num(r.net_sales),
      orders: num(r.orders),
      avgPrice: num(r.avg_price),
      compQty: num(r.comp_qty),
      prevQty: num(r.prev_qty),
      prevNetSales: num(r.prev_net_sales),
    })),
    totals: {
      qty: num(t.qty),
      netSales: num(t.net_sales),
      orders: num(t.orders),
      prevQty: num(t.prev_qty),
      prevNetSales: num(t.prev_net_sales),
      prevFrom: String(t.prev_from ?? ''),
      prevTo: String(t.prev_to ?? ''),
    },
  };
}

async function fetchSalesByChannel(from: string, to: string): Promise<ChannelSalesReport> {
  const d = await callJson('get_sales_by_channel', { p_from: from, p_to: to });
  return {
    channels: rows(d.channels).map((r) => ({
      orderType: String(r.order_type ?? ''),
      orderSource: String(r.order_source ?? 'pos'),
      orders: num(r.orders),
      grossSales: num(r.gross_sales),
      discounts: num(r.discounts),
      netSales: num(r.net_sales),
      tax: num(r.tax),
      total: num(r.total),
    })),
    categories: rows(d.categories).map((r) => ({
      categoryId: strOrNull(r.category_id),
      category: String(r.category ?? 'Uncategorised'),
      qty: num(r.qty),
      netSales: num(r.net_sales),
      orders: num(r.orders),
      items: num(r.items),
    })),
  };
}

export const reports: ReportRepository = {
  dailySummary: fetchDailySummary,
  salesByHour: fetchSalesByHour,
  productMix: fetchProductMix,
  salesByChannel: fetchSalesByChannel,
  voidsDiscounts: fetchVoidsDiscounts,
  menuAvailability: fetchMenuAvailability,
  salesByWaiter: fetchSalesByWaiter,
  salesReport: fetchSalesReport,
  topItems: fetchTopItems,
  salesByOrderType: fetchSalesByOrderType,
  salesByTypeBucketed: fetchSalesByTypeBucketed,
};
