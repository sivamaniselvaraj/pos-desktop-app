// Shared types: imported by both the Electron main process and the React renderer.

export interface OrderItem {
  id: string;
  menuItemId?: string;
  name: string;
  quantity: number;
  unit_price: number;
  total_price: number
  //status: string;
  specialInstructions?: string;
  kotPrinted?: boolean;
  kotPrintedAt?: string;
}

export type OrderType = 'delivery' | 'pickup' | 'dine-in' | 'takeaway' | 'dine_in';

export interface OutletInfo {
  id: string;
  name: string;
  city?: string;
  phone?: string;
  gstNumber?: string;
  address?: string;
}

/**
 * Printer header/footer configuration, typically stored as a JSON string.
 * headerText / footerText may contain `<br>` (any case) as line breaks.
 */
export interface HeaderConfig {
  restaurantName?: string;
  headerText?: string;
  footerText?: string;
  containerChargePercent?: string;
}

export interface FoodOrder {
  id: string;
  orderId: string;
  orderNumber: number;
  tokenNumber?: number;
  outlet?: OutletInfo;
  customerName: string;
  customerPhone?: string;
  deliveryAddress?: string;
  items: OrderItem[];
  subtotal: number;
  tax: number;
  total: number;
  /** Pickup orders only; 0/undefined for dine-in and delivery. */
  containerCharge?: number;
  discount?: number;
  orderType: OrderType;
  specialNotes?: string;
  createdAt: string;
  tableNumber?: number;
  /** 'open' | 'completed' | 'cancelled' — used e.g. to decide the DUPLICATE BILL banner on reprint. */
  status?: string;
  /** Raw header/footer config (JSON string or object) for the receipt. */
  headerConfig?: string | HeaderConfig;
  /**
   * Set only on a grouped table bill (settle flow merging every open order
   * on a dine-in table into one printout). When present, printerManager
   * prints this list on the "Bill No." line instead of the single
   * orderNumber. Undefined/absent for a normal single-order print.
   */
  orderNumbers?: number[];
  placedBy?: string;
}

export type PrintStatus = 'pending' | 'printing' | 'printed' | 'failed';

export interface OrderWithStatus extends FoodOrder {
  printStatus: PrintStatus;
  errorMessage?: string;
  printedAt?: string;
  retryCount: number;
}

// ---- HTTP contract (Android app -> local server) ----
export type PrintType = 'bill' | 'kot' | 'settle';

export type SettleOrderType = 'dine-in' | 'takeaway';

// ---- HTTP contract (Android app -> local server) ----
export interface PrintOrderRequest {
  /** KOT/plain-bill prints still key on this (Android already has it at order-creation time). Also still accepted for a legacy 'settle' request with no orderType. */
  orderId?: string;
  /**
   * Required (with tableNumber or orderNumber) for a 'settle' request.
   * Tells the server up front which resolution path to take — 'dine-in'
   * fetches every order number in the named table's current batch in one
   * query; 'takeaway' settles orderNumber standalone. Omitting it falls
   * back to the legacy orderId-only settle path.
   */
  orderType?: SettleOrderType;
  /** 'settle' reference for a DINE-IN table (with orderType: 'dine-in') — the table number, not a UUID. */
  tableNumber?: string;
  /** 'settle' reference for a TAKEAWAY order (with orderType: 'takeaway') — the order number, not a UUID. Settles standalone, no grouping. */
  orderNumber?: number;
  type?: PrintType;
}

export interface PrintOrderResponse {
  success: boolean;
  orderId: string;
  message: string;
  printStatus: PrintStatus;
  error?: string;
}

export type ReportBucket = 'day' | 'month';

/** One row per bucket (day or month) — never per order. */
export interface SalesReportRow {
  date: string; // bucket_date, 'YYYY-MM-DD' (first-of-month for month buckets)
  orderCount: number;
  taxTotal: number;
  netTotal: number;
  avgOrderValue: number;
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

export type UserRole = 'staff' | 'manager' | 'owner' | 'admin';

export interface ManagedUser {
  userId: string;
  email: string;
  firstName: string;
  phone?: string;
  role: UserRole;
  isActive: boolean;
  outletId?: string;
  outletName?: string;
  createdAt: string;
}

export interface OutletOption {
  id: string;
  name: string;
}

export type OrderListStatus = 'active' | 'completed' | 'cancelled';

export interface OrderListRow {
  orderId: string;
  orderNumber: string;
  orderType: string;
  createdAt: string;
  itemCount: number;
  subtotalAmount: number;
  taxAmount: number;
  containerChargeAmount: number;
  discountAmount: number;
  totalAmount: number;
  status: string;
  hasEdits: boolean;
}

export interface OrderListPage {
  rows: OrderListRow[];
  totalRows: number;
}

export interface OrderListFilter {
  status: OrderListStatus | null;
  search?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

export interface OrderDetailItem {
  orderItemId: string;
  menuItemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  isDeleted: boolean;
  editedAt?: string;
    /** Set only when fetched via getTableOrderDetail — which order (round) this item belongs to, for grouping in a multi-order table view. Absent for a single-order fetch. */
  orderId?: string;
  orderNumber?: number;
}

export interface EditOrderItemPayload {
  orderItemId: string;
  quantity: number;
  reason?: string;
}

export interface TableOrderDetail {
  /** Every order (round) currently grouped for this table, in order# order. */
  orders: { id: string; orderNumber: number }[];
  /** All orders' items, each tagged with orderId/orderNumber (see OrderDetailItem). */
  items: OrderDetailItem[];
}

export interface OrderActivityLogEntry {
  auditId: string;
  orderItemId: string;
  itemName: string;
  action: 'edit' | 'delete';
  changedAt: string;
  changedByName: string;
  oldQuantity?: number;
  newQuantity?: number;
  oldUnitPrice?: number;
  newUnitPrice?: number;
  reason?: string;
    /** Set only when fetched via getTableActivityLog — which order (round) this entry belongs to. Absent for a single-order fetch. */
  orderNumber?: number;
}

/**
 * A menu item's shape is deliberately NOT fixed here — menu_items' real
 * columns beyond id/name have never been confirmed anywhere in this project
 * (see get_menu_items_for_outlet's comment in db/functions.sql). Each item
 * is whatever JSON object the database actually returns; the Menu page
 * renders whichever keys are present rather than assuming specific fields.
 */
export type MenuItemRecord = Record<string, unknown>;

export type TableCardStatus = 'active' | 'settled' | 'available';

export interface TableCard {
  tableId: string;
  tableNumber: string;
  tableState: string;
    /**
   * Every order in the table's current batch — every dine-in round that
   * isn't cancelled and isn't both completed AND paid yet (see
   * list_tables_for_outlet() in db/functions.sql). Empty/undefined when the
   * table has nothing outstanding (cardStatus 'available'). A table can have
   * more than one entry here: separate rounds ordered before the table was
   * settled all bill and pay together.
   */
  orderIds?: string[];
  /** Order numbers for orderIds, in the same grouping — shown on cards/dialogs instead of a single order#. */
  orderNumbers?: number[];
  orderId?: string;
  orderStatus?: string;
  orderCreatedAt?: string;
  orderTotalAmount?: number;
  /** Derived client-side from orderStatus — 'available' when there's no recent order at all. */
  cardStatus: TableCardStatus;
    /** True once every order in the batch has payment_details set (transient — a fully-paid batch drops out of the next list). */
  paymentRecorded?: boolean;
}
export type PaymentMethod = 'card' | 'cash' | 'upi' | 'part-payment';

export interface SavePaymentPayload {
  /** Any one order id from the table's batch — the RPC resolves the rest via its table_id. */
  orderId: string;
  method: PaymentMethod;
  cashAmount?: number;
  cardAmount?: number;
  upiAmount?: number;
}

export interface MenuCacheSnapshot {
  items: MenuItemRecord[];
  lastRefreshedAt: string | null;
  lastError: string | null;
}

export interface CreateUserPayload {
  email: string;
  password: string;
  firstName: string;
  phone?: string;
  role: UserRole;
  outletId?: string;
}

export interface UpdateUserPayload {
  userId: string;
  firstName: string;
  phone?: string;
  role: UserRole;
  outletId?: string;
}

export interface PrinterInfo {
  name: string;
  isDefault: boolean;
  online: boolean;
}

export interface ServerStatus {
  running: boolean;
  port: number;
  host: string;
  database: 'connected' | 'disconnected';
   /** This machine's LAN IPv4 address (first non-internal interface) — what Android should actually point at, as opposed to `host` (the bind address, often 0.0.0.0). Null if none could be found (no active network interface). */
  ipAddress: string | null;
}

// ---- Authentication / authorization ----
export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: string;
  isActive: boolean;
  outletId?: string;
  /** Displayed below the header title (see Header.tsx). Undefined if the profile has no outlet_id, or that outlet couldn't be resolved. */
  outletName?: string;
}

export interface AuthResult {
  success: boolean;
  user?: AuthUser;
  error?: string;
}

// ---- IPC channel names (single source of truth) ----
export const IpcChannels = {
  // auth (renderer -> main, invoke)
  AUTH_SIGN_IN: 'auth:sign-in',
  AUTH_SIGN_OUT: 'auth:sign-out',
  AUTH_GET_SESSION: 'auth:get-session',
  // renderer -> main (invoke)
  GET_ORDERS: 'get-orders',
  RETRY_PRINT: 'retry-print',
  CANCEL_ORDER: 'cancel-order',
  CLEAR_PRINTED: 'clear-printed',
  // printers (renderer -> main, invoke)
  GET_PRINTERS: 'get-printers',
  //report (renderer -> main, invoke)
  GET_SALES_REPORT: 'get-sales-report',
  GET_TOP_ITEMS: 'get-top-items',
  GET_SALES_BY_ORDER_TYPE: 'get-sales-by-order-type',
  GET_SALES_BY_TYPE_BUCKETED: 'get-sales-by-type-bucketed',
  EXPORT_SALES_REPORT: 'export-sales-report',
  LIST_USERS: 'list-users',
  LIST_OUTLETS: 'list-outlets',
  CREATE_USER: 'create-user',
  UPDATE_USER: 'update-user',
  SET_USER_ACTIVE: 'set-user-active',
  LIST_ORDERS: 'list-orders',
  GET_ORDER_DETAIL: 'get-order-detail',
  GET_TABLE_ORDER_DETAIL: 'get-table-order-detail',
  GET_TABLE_ACTIVITY_LOG: 'get-table-activity-log',
  EDIT_ORDER_ITEM: 'edit-order-item',
  DELETE_ORDER_ITEM: 'delete-order-item',
  CANCEL_ORDER_WITH_REASON: 'cancel-order-with-reason',
  COMPLETE_ORDER: 'complete-order',
  REPRINT_ORDER: 'reprint-order',
  GET_ORDER_ACTIVITY_LOG: 'get-order-activity-log',
  GET_MENU_ITEMS: 'get-menu-items',
  REFRESH_MENU_CACHE: 'refresh-menu-cache',
  SET_MENU_ITEM_ACTIVE: 'set-menu-item-active',
  LIST_TABLES: 'list-tables',
  CREATE_TABLE: 'create-table',
  SAVE_ORDER_PAYMENT: 'save-order-payment',
  REPRINT_TABLE_BILL: 'reprint-table-bill',
  TEST_PRINT: 'test-print',
  // settings (renderer -> main, invoke)
  GET_SETTINGS: 'get-settings',
  UPDATE_SETTINGS: 'update-settings',
  REMOVE_PRINTER: 'remove-printer',
  GET_MAX_PRINTERS: 'get-max-printers',
  // server (renderer -> main, invoke)
  GET_SERVER_STATUS: 'get-server-status',
  // main -> renderer (send)
  ORDER_RECEIVED: 'order-received',
  ORDER_STATUS_CHANGED: 'order-status-changed',
  PRINTER_STATUS: 'printer-status',
  SERVER_STATUS: 'server-status',
} as const;

// Shape exposed on window.api by the preload bridge.
export interface ElectronApi {
  signIn(email: string, password: string): Promise<AuthResult>;
  signOut(): Promise<void>;
  getSession(): Promise<AuthUser | null>;
  getOrders(): Promise<OrderWithStatus[]>;
  retryPrint(orderId: string): Promise<PrintOrderResponse>;
  cancelOrder(orderId: string): Promise<void>;
  clearPrinted(): Promise<void>;
  getPrinters(): Promise<PrinterInfo[]>;
  getSalesReport(from: string, to: string, bucket: ReportBucket): Promise<SalesReportRow[]>;
  getTopItems(from: string, to: string): Promise<TopItemRow[]>;
  getSalesByOrderType(from: string, to: string): Promise<SalesByOrderTypeRow[]>;
  getSalesByTypeBucketed(
    from: string,
    to: string,
    bucket: ReportBucket,
  ): Promise<SalesByTypeBucketRow[]>;
  exportSalesReport(payload: SalesReportExportPayload): Promise<ExportResult>;
  listUsers(): Promise<ManagedUser[]>;
  listOutlets(): Promise<OutletOption[]>;
  createUser(payload: CreateUserPayload): Promise<void>;
  updateUser(payload: UpdateUserPayload): Promise<void>;
  setUserActive(userId: string, isActive: boolean): Promise<void>;
  listOrders(filter: OrderListFilter): Promise<OrderListPage>;
  getOrderDetail(orderId: string): Promise<OrderDetailItem[]>;
  getTableOrderDetail(orderId: string): Promise<TableOrderDetail>;
  getTableActivityLog(orderId: string): Promise<OrderActivityLogEntry[]>;
  editOrderItem(payload: EditOrderItemPayload): Promise<void>;
  deleteOrderItem(orderItemId: string, reason?: string): Promise<void>;
  cancelOrderWithReason(orderId: string, reason: string): Promise<void>;
  completeOrder(orderId: string): Promise<void>;
  reprintOrder(orderId: string): Promise<void>;
  getOrderActivityLog(orderId: string): Promise<OrderActivityLogEntry[]>;
  getMenuItems(): Promise<MenuCacheSnapshot>;
  refreshMenuCache(): Promise<MenuCacheSnapshot>;
  setMenuItemActive(menuItemId: string, isActive: boolean): Promise<MenuCacheSnapshot>;
  listTables(): Promise<TableCard[]>;
  createTable(tableNumber: string): Promise<void>;
  savePayment(payload: SavePaymentPayload): Promise<void>;
  reprintTableBill(orderId: string): Promise<void>;
  testPrint(target?: string): Promise<string>;
  getSettings(): Promise<Record<string, string>>;
  updateSettings(printerType: string, deviceName: string): Promise<void>;
  removePrinter(printerType: string): Promise<void>;
  getMaxPrinters(): Promise<number>;
  getServerStatus(): Promise<ServerStatus>;
  onOrderReceived(cb: (order: OrderWithStatus) => void): () => void;
  onOrderStatusChanged(cb: (order: OrderWithStatus) => void): () => void;
  onPrinterStatus(cb: (printers: PrinterInfo[]) => void): () => void;
  onServerStatus(cb: (status: ServerStatus) => void): () => void;
}

declare global {
  interface Window {
    api: ElectronApi;
  }
}
