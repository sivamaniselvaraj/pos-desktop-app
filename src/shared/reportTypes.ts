// Report types (Sales Report tabs, menu availability, voids and discounts, export).
// Shared by the main process and the renderer. See docs/SALES_REPORTS.md and docs/VOIDS_DISCOUNTS_REPORT.md.

export type ReportBucket = 'day' | 'month';

/** One row per bucket (day or month) — never per order. */
export interface SalesReportRow {
  date: string; // bucket_date, 'YYYY-MM-DD' (first-of-month for month buckets)
  orderCount: number;
  taxTotal: number;
  netTotal: number;
  avgOrderValue: number;
}

/** Menu availability report (get_menu_availability): when items were turned off, why, and for how long. */
export interface MenuAvailabilityReport {
  summary: {
    offEvents: number;
    itemsAffected: number;
    downtimeHours: number;
    /** Estimate: units normally sold in the hours the items were off. */
    lostUnits: number;
    /** Estimate: lostUnits at the price they sold for. */
    lostValue: number;
    categoryOffEvents: number;
    topReason: string | null;
    currentlyOff: number;
  };
  items: {
    menuItemId: string;
    name: string;
    category: string | null;
    timesOff: number;
    downtimeHours: number;
    longestHours: number;
    stillOff: boolean;
    topReason: string | null;
    lostUnits: number;
    lostValue: number;
  }[];
  reasons: { reason: string; count: number; downtimeHours: number }[];
  categoryEvents: {
    categoryId: string | null;
    category: string;
    offAt: string;
    reason: string;
    itemCount: number;
    downtimeHours: number;
    stillOff: boolean;
  }[];
  timeline: {
    menuItemId: string;
    name: string;
    category: string | null;
    offAt: string;
    onAt: string | null;
    hours: number;
    reason: string;
    by: string | null;
    scope: 'item' | 'category';
  }[];
  staff: { name: string; offs: number; ons: number }[];
  byWeekday: { dow: number; count: number }[];
  byHour: { hour: number; count: number }[];
  currentlyOff: { menuItemId: string; name: string; category: string | null; reason: string | null; since: string | null; by: string | null }[];
}

/** One waiter's settled sales in a date range (get_sales_by_waiter). waiterId is null for orders with no waiter. */
export interface SalesByWaiterRow {
  waiterId: string | null;
  waiterName: string;
  orderCount: number;
  invoiceCount: number;
  itemsSold: number;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  /** total - tax: the sale before tax. */
  salesExclTax: number;
  /** What the guests paid. */
  totalSales: number;
  avgOrderValue: number;
  /** Value before tax of the lines that earn an incentive. */
  eligibleSales: number;
  /** Incentive earned, from the rule copied onto each line when it was sold. */
  incentiveTotal: number;
}

/** What one row of the Voids and discounts report is (get_voids_discounts). */
export type VoidEventKind =
  | 'item_removed'
  | 'qty_reduced'
  | 'order_cancelled'
  | 'kitchen_cancelled'
  | 'discount'
  | 'complimentary'
  | 'discount_removed';

/** One void, cancellation or discount change, with who did it and why. */
export interface VoidEvent {
  id: string;
  at: string;
  kind: VoidEventKind;
  orderId: string;
  orderNumber: number | null;
  invoiceNumber: string | null;
  orderType: string;
  /** The order's status now (open, completed, cancelled). */
  orderStatus: string;
  tableNumber: string | null;
  /** Item name, or "2 x Dosa, 1 x Vada" for a kitchen cancel; null for order-level rows. */
  item: string | null;
  /** Units voided (removed, reduced by, or cancelled in the kitchen). */
  qty: number | null;
  /** Money taken off: line value, order total or discount amount. */
  value: number;
  /** "Quantity 3 to 1", "10% off", "Whole bill cancelled" and so on. */
  detail: string | null;
  reason: string | null;
  /** The signed-in user who did it. */
  by: string;
  /** The editor account that approved it (edits, removals and cancels). */
  approvedBy: string | null;
}

export interface VoidsDiscountsReport {
  summary: {
    events: number;
    voidCount: number;
    voidQty: number;
    voidValue: number;
    kitchenCancelCount: number;
    kitchenCancelValue: number;
    cancelledOrders: number;
    cancelledValue: number;
    /** From the orders: discounts still in place, given in the range, order not cancelled. */
    discountOrders: number;
    discountValue: number;
    complimentaryOrders: number;
    complimentaryValue: number;
    /** Rows with no reason (KOT moves to Cancelled from older apps or kitchen screens). */
    noReason: number;
  };
  events: VoidEvent[];
  staff: {
    name: string;
    voids: number;
    voidValue: number;
    cancels: number;
    cancelValue: number;
    discounts: number;
    discountValue: number;
    totalValue: number;
  }[];
  reasons: { reason: string; count: number; value: number }[];
}

export interface TopItemRow {
  menuItemId: string;
  name: string;
  quantitySold: number;
  revenue: number;
}

export interface SalesByOrderTypeRow {
  orderType: string;
  orderCount: number;
}

export interface SalesByTypeBucketRow {
  date: string;
  dineInCount: number;
  pickupCount: number;
  deliveryCount: number;
}

// ---- Sales and revenue reports (docs/SALES_REPORTS.md) ----

/** Optional shift window for the daily summary: outlet-local "HH:MM"; end before start runs past midnight. */
export interface ShiftWindow {
  start: string;
  end: string;
}

/** Daily summary / Z-report (get_daily_summary). */
export interface DailySummaryReport {
  summary: {
    orders: number;
    invoices: number;
    itemsSold: number;
    /** Before discount and tax (net sales + discounts + complimentary). */
    grossSales: number;
    discounts: number;
    discountOrders: number;
    complimentary: number;
    complimentaryOrders: number;
    /** After discount, before tax (total - tax). */
    netSales: number;
    containerCharges: number;
    tax: number;
    /** What the guests paid. */
    total: number;
    avgOrderValue: number;
    avgBillValue: number;
    firstOrderAt: string | null;
    lastOrderAt: string | null;
    cancelledOrders: number;
    cancelledValue: number;
  };
  taxLines: { name: string; rate: number | null; taxable: number; tax: number }[];
  /** cash | card | upi | unpaid; part payments are shared between their methods. */
  payments: { method: string; orders: number; amount: number }[];
  orderTypes: { orderType: string; orders: number; netSales: number; total: number }[];
  days: { date: string; orders: number; grossSales: number; discounts: number; netSales: number; tax: number; total: number }[];
}

/** Hourly sales (get_sales_by_hour): one cell per weekday (0 = Sunday) and hour that had sales. */
export interface HourlySalesReport {
  cells: { dow: number; hour: number; orders: number; itemsSold: number; netSales: number; total: number }[];
  /** days = that weekday's count in the range; daysOpen = how many of them had a completed order. */
  days: { dow: number; days: number; daysOpen: number }[];
}

/** One menu item in the product mix (get_product_mix). menuItemId is null for the "Removed item" row. */
export interface ProductMixItem {
  menuItemId: string | null;
  name: string;
  category: string;
  isActive: boolean;
  qty: number;
  /** Line value before tax and before order discounts. */
  netSales: number;
  orders: number;
  avgPrice: number;
  /** Units given on complimentary orders (counted in qty). */
  compQty: number;
  prevQty: number;
  prevNetSales: number;
}

export interface ProductMixReport {
  items: ProductMixItem[];
  totals: { qty: number; netSales: number; orders: number; prevQty: number; prevNetSales: number; prevFrom: string; prevTo: string };
}

/** Sales by channel and category (get_sales_by_channel). */
export interface ChannelSalesReport {
  channels: {
    orderType: string;
    orderSource: string;
    orders: number;
    grossSales: number;
    discounts: number;
    netSales: number;
    tax: number;
    total: number;
  }[];
  categories: { categoryId: string | null; category: string; qty: number; netSales: number; orders: number; items: number }[];
}

export type ReportExportFormat = 'csv' | 'xlsx';

export interface SalesReportExportPayload {
  rows: SalesReportRow[];
  topItems: TopItemRow[];
  format: ReportExportFormat;
  range: { from: string; to: string };
}

export interface ExportResult {
  success: boolean;
  path?: string;
  error?: string;
}
