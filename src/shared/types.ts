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

export type OrderType = 'delivery' | 'pickup' | 'dine-in' | 'takeaway';

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
  tokenNumber: number;
  tableNumber: number;
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
  /** 'open' | 'completed' | 'cancelled' — used e.g. to decide the DUPLICATE BILL banner on reprint. */
  status?: string;
  /** Raw header/footer config (JSON string or object) for the receipt. */
  headerConfig?: string | HeaderConfig;
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

// ---- HTTP contract (Android app -> local server) ----
export interface PrintOrderRequest {
  orderId: string;
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
}

export interface EditOrderItemPayload {
  orderItemId: string;
  quantity: number;
  reason?: string;
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
}

// ---- Authentication / authorization ----
export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: string;
  isActive: boolean;
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
  EXPORT_SALES_REPORT: 'export-sales-report',
  LIST_USERS: 'list-users',
  LIST_OUTLETS: 'list-outlets',
  CREATE_USER: 'create-user',
  UPDATE_USER: 'update-user',
  SET_USER_ACTIVE: 'set-user-active',
  LIST_ORDERS: 'list-orders',
  GET_ORDER_DETAIL: 'get-order-detail',
  EDIT_ORDER_ITEM: 'edit-order-item',
  DELETE_ORDER_ITEM: 'delete-order-item',
  CANCEL_ORDER_WITH_REASON: 'cancel-order-with-reason',
  COMPLETE_ORDER: 'complete-order',
  REPRINT_ORDER: 'reprint-order',
  GET_ORDER_ACTIVITY_LOG: 'get-order-activity-log',
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
  exportSalesReport(payload: SalesReportExportPayload): Promise<ExportResult>;
  listUsers(): Promise<ManagedUser[]>;
  listOutlets(): Promise<OutletOption[]>;
  createUser(payload: CreateUserPayload): Promise<void>;
  updateUser(payload: UpdateUserPayload): Promise<void>;
  setUserActive(userId: string, isActive: boolean): Promise<void>;
  listOrders(filter: OrderListFilter): Promise<OrderListPage>;
  getOrderDetail(orderId: string): Promise<OrderDetailItem[]>;
  editOrderItem(payload: EditOrderItemPayload): Promise<void>;
  deleteOrderItem(orderItemId: string, reason?: string): Promise<void>;
  cancelOrderWithReason(orderId: string, reason: string): Promise<void>;
  completeOrder(orderId: string): Promise<void>;
  reprintOrder(orderId: string): Promise<void>;
  getOrderActivityLog(orderId: string): Promise<OrderActivityLogEntry[]>;
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
