// Shared types: imported by both the Electron main process and the React renderer.

export interface OrderItem {
  id: string;
  menuItemId?: string;
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice?: number;
  //status: string;
  specialInstructions?: string;
  kotPrinted?: boolean;
  kotPrintedAt?: string;
}

export type OrderType = 'delivery' | 'pickup' | 'dine-in' | 'takeaway' | 'dine_in';

export const DINE_IN_ORDER_TYPE = 'dine_in' as const;
export const PICK_UP_ORDER_TYPE = 'takeaway' as const;

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
  /** Tax per rate (one line per rate). Empty for orders placed before per-rate tax. */
  taxBreakdown?: TaxBreakdownLine[];
  total: number;
  /** Pickup orders only; 0/undefined for dine-in and delivery. */
  containerCharge?: number;
  discount?: number;
  orderType: OrderType;
  specialNotes?: string;
  createdAt: string;
  tableNumber?: string | number;
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
  /**
   * Format YYYY-MM-DD-NNNNN (assign_invoice_number() trigger, db/schema.sql).
   * Assigned once per dine-in table batch (every round on that table shares
   * it until the table is settled + paid) or once per takeaway/pickup order.
   * Undefined only for pre-existing orders created before this column
   * existed.
   */
  invoiceNumber?: string;
}

export type PrintStatus = 'pending' | 'printing' | 'printed' | 'failed';

export interface OrderWithStatus extends FoodOrder {
  printStatus: PrintStatus;
  errorMessage?: string;
  printedAt?: string;
  retryCount: number;
}

// ---- Paired devices (phones that may call the local API) ----
export interface ApiDevice {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

/** Returned once at creation; the token is never stored or shown again. */
export interface CreatedApiDevice extends ApiDevice {
  token: string;
}

// ---- HTTP contract (Android app -> local server) ----
export type PrintType = 'bill' | 'kot' | 'settle';

export type SettleOrderType = 'dine_in' | 'takeaway';

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

export type UserRole = 'staff' | 'manager' | 'owner' | 'admin' | 'editor';

export interface ManagedUser {
  userId: string;
  email: string;
  fullName: string;
  phone?: string;
  role: UserRole;
  isActive: boolean;
  outletId?: string;
  outletName?: string;
  createdAt: string;
}

/** A permission that can be granted to a group. */
export interface PermissionInfo {
  code: string;
  description: string;
}

/** A named bundle of permissions. Members inherit them on top of their role. */
export interface UserGroup {
  id: string;
  name: string;
  description: string;
  memberCount: number;
  permissions: string[];
}

export interface SaveGroupPayload {
  id?: string; // absent = create
  name: string;
  description: string;
  permissions: string[];
}

/** One (user, group) membership. */
export interface GroupMembership {
  userId: string;
  groupId: string;
}

/** Why a user has a permission: 'role' and/or 'group: <name>'. */
export interface UserAccessEntry {
  permission: string;
  description: string;
  via: string[];
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
  hasEdits?: boolean;
  /** Dine-in rows only — the table this order was placed at. Absent for takeaway/pickup rows. */
  tableId?: string;
  /** Dine-in rows only — the table's display number, e.g. "T4". Absent for takeaway/pickup rows. */
  tableNumber?: string;
  /** Format YYYY-MM-DD-NNNNN — see FoodOrder.invoiceNumber. Undefined only for orders created before this column existed. */
  invoiceNumber?: string;
  /**
   * How many individual orders (rounds) are merged into this row — the grid
   * groups by invoice_number, so a dine-in table with several rounds under
   * one invoice appears as ONE row with orderCount > 1 rather than one row
   * per round. Always 1 for takeaway/pickup (each gets its own invoice
   * number) and for a dine-in order with no invoice_number yet (pre-feature
   * legacy row). orderId/status/totals on a grouped row are aggregated
   * across the whole group — see list_orders() in db/functions.sql — so
   * Complete/Cancel (single-order operations) are disabled in the UI
   * whenever this is > 1, to avoid guessing which round a click means.
   */
  orderCount: number;
  /** How many of those orders are cancelled. 0 < cancelledCount < orderCount is a partial cancel. */
  cancelledCount: number;
}

/** Settings page's "Invoicing" panel — admin-only (see get_invoice_sequence_status()/reset_invoice_sequence() in db/functions.sql). */
export interface InvoiceSequenceStatus {
  outletId: string;
  /** How many invoice numbers have been issued since the last reset (or ever, if never reset). The NEXT order gets currentSeq + 1. */
  currentSeq: number;
  /** Null if this outlet's sequence has never been manually reset. */
  lastResetAt: string | null;
  /** Display name of whoever triggered the last reset, if any. */
  resetByName?: string;
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

/**
 * Second-factor approval: an 'editor' account's username (email) + password,
 * entered fresh for EVERY edit/delete/cancel and verified server-side inside
 * the RPC. Never stored or cached by the app.
 */
export interface EditorApproval {
  username: string;
  password: string;
}

export interface EditOrderItemPayload {
  orderItemId: string;
  quantity: number;
  /** Required — the UI always collects this before saving an edit. */
  reason: string;
  approval: EditorApproval;
}

export interface TableOrderDetail {
  /** Every order (round) currently grouped for this table, in order# order. */
  orders: { id: string; orderNumber: number; status?: string }[];
  /** All orders' items, each tagged with orderId/orderNumber (see OrderDetailItem). */
  items: OrderDetailItem[];
}

export interface OrderActivityLogEntry {
  auditId: string;
  orderItemId: string;
  itemName: string;
  action: string;
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
 *
 * Two exceptions with guaranteed key names: category_id and category_name,
 * explicitly added by the RPC's categories join (via jsonb_build_object,
 * not just whatever menu_items' own column happens to be called) — null on
 * either if the item has no category assigned.
 */
export type MenuItemRecord = Record<string, unknown>;

export interface AccessMenu {
  /** Route id the app knows about (e.g. 'orders-list'). */
  code: string;
  label: string;
  /** Icon name from the app's bundled set; unknown names fall back to a default. */
  icon: string;
}

/** The signed-in user's organization's presentation settings. */
export interface OrgSettings {
  id: string;
  name: string;
  currencyCode: string;
  locale: string;
  /** IANA timezone of the user's outlet (its override, else the organization's). */
  timezone: string;
  taxLabel: string;
}

export interface MyAccess {
  role: string | null;
  org: OrgSettings | null;
  permissions: string[];
  menus: AccessMenu[];
  /** Names of the groups the user belongs to. */
  groups?: string[];
}

export interface MenuCategory {
  id: string;
  name: string;
}

/** Add (no id) or edit (id) a menu item. outlet_id is always this machine's outlet. */
export interface SaveMenuItemPayload {
  id?: string;
  name: string;
  categoryId: string;
  price: number;
  description?: string;
  isVeg: boolean;
  /** Percentage of the line total, applied to pickup orders only. */
  containerCharge: number | null;
  costPrice: number | null;
  /** Comma/space separated search keywords. */
  searchKey?: string;
  /** Minutes. */
  cookingTime: number | null;
  sortOrder: number | null;
  imageUrl?: string;
  isAvailable: boolean;
  isActive: boolean;
}

/** One cart line sent to place_order / place_pickup_order. */
export interface PlaceOrderLine {
  menuItemId: string;
  quantity: number;
  /** Re-read from the menu cache in the main process; the renderer's value is not trusted. */
  containerPercent?: number;
}

export interface PlaceOrderPayload {
  orderType: OrderType;
  /** Required for dine-in. */
  tableId?: string;
  items: PlaceOrderLine[];
  customerName?: string;
  customerPhone?: string;
  notes?: string;
}

export interface PlaceOrderResult {
  orderId: string;
  orderNumber?: number;
  invoiceNumber?: string;
  total: number;
}

export interface TaxRate {
  name: string;
  ratePercent: number;
}

/** The rates in force now for the signed-in user's outlet (New Order page). */
export interface TaxRates {
  /** Outlet default; used for categories without their own rate. */
  defaultRate: TaxRate & { configured: boolean };
  /** Category id -> that category's own rate. */
  byCategory: Record<string, TaxRate>;
}

/** One line of the bill's tax summary: tax for one rate. */
export interface TaxBreakdownLine {
  name: string;
  rate: number;
  taxable: number;
  tax: number;
}

/** A row on the Tax rates screen. categoryId null = the outlet default. */
export interface TaxRateRow {
  id: string;
  categoryId: string | null;
  taxName: string;
  /** null = this category goes back to the outlet default. */
  ratePercent: number | null;
  effectiveFrom: string;
  createdAt: string;
  createdByName?: string;
  state: 'scheduled' | 'current' | 'past';
}

export interface AddTaxRatePayload {
  /** null = outlet default. */
  categoryId: string | null;
  taxName: string;
  /** null (categories only) = go back to the outlet default. */
  ratePercent: number | null;
  /** Local date-time at the outlet (yyyy-MM-ddTHH:mm); empty = now. */
  effectiveLocal?: string;
}

// ---- KOT board ----------------------------------------------------------
export interface KotStatus {
  id: string;
  name: string;
  color: string;
  /** Label of the button that moves a KOT INTO this step. */
  actionLabel: string | null;
  sortOrder: number;
  isInitial: boolean;
  isFinal: boolean;
  showOnBoard: boolean;
}
export interface KotTimeLevel {
  name: string;
  fromMinutes: number;
  color: string;
}
export interface KotCardItem {
  id: string;
  name: string;
  quantity: number;
  note: string | null;
  isDeleted: boolean;
}
export interface KotCard {
  /** Stable key for the UI (order:step). A card = the order's items sitting in one step. */
  id: string;
  statusId: string;
  createdAt: string;
  orderId: string;
  orderNumber: number;
  orderType: string;
  tableNumber: string | null;
  customerName: string | null;
  notes: string | null;
  items: KotCardItem[];
}
export interface KotBoard {
  /** Server time when the board was read (to correct clock differences). */
  now: string;
  statuses: KotStatus[];
  /** Allowed moves: from -> to. */
  transitions: { from: string; to: string }[];
  levels: KotTimeLevel[];
  kots: KotCard[];
}

export interface KotWorkflowStep {
  /** Absent for a step that has not been saved yet. */
  id?: string;
  /** The order_items.status value of this step; fixed once saved. */
  code: string;
  name: string;
  color: string;
  actionLabel: string;
  showOnBoard: boolean;
  /** 1-based positions of the earlier steps a KOT may go back to. */
  backTo: number[];
  /** Read-only: KOTs currently in this step. */
  kotCount?: number;
}
export interface KotWorkflow {
  steps: KotWorkflowStep[];
  levels: KotTimeLevel[];
}

export type ManagedTableStatus = 'available' | 'occupied' | 'reserved' | 'cleaning';

/** One row on the Tables management page. */
export interface ManagedTable {
  tableId: string;
  tableNumber: string;
  floor: string;
  capacity: number | null;
  /** The stored/manual status. */
  status: ManagedTableStatus;
  /** What the table is really doing now — 'occupied' while it carries a live order. */
  effectiveStatus: ManagedTableStatus;
  activeOrderCount: number;
}

export interface SaveManagedTablePayload {
  /** Omit to create a new table. */
  tableId?: string;
  tableNumber: string;
  floor: string;
  capacity: number | null;
  status: ManagedTableStatus;
}

export type TableCardStatus = 'active' | 'settled' | 'available';

export interface TableCard {
  tableId: string;
  tableNumber: string;
  tableState: string;
  /** Invoice shared by every order in the table's current sitting; used to fetch the detail. */
  invoiceNumber?: string;
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
  fullName: string;
  phone?: string;
  role: UserRole;
  outletId?: string;
  /** Groups to put the new user in. Access comes only from groups. */
  groupIds?: string[];
}

export interface UpdateUserPayload {
  userId: string;
  fullName: string;
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
  LIST_GROUPS: 'list-groups',
  LIST_PERMISSIONS: 'list-permissions',
  LIST_GROUP_MEMBERSHIPS: 'list-group-memberships',
  SAVE_GROUP: 'save-group',
  DELETE_GROUP: 'delete-group',
  SET_GROUP_MEMBERS: 'set-group-members',
  SET_USER_GROUPS: 'set-user-groups',
  GET_USER_ACCESS: 'get-user-access',
  LIST_ORDERS: 'list-orders',
  GET_INVOICE_ORDER_DETAIL: 'get-invoice-order-detail',
  GET_INVOICE_ACTIVITY_LOG: 'get-invoice-activity-log',
  EDIT_ORDER_ITEM: 'edit-order-item',
  DELETE_ORDER_ITEM: 'delete-order-item',
  CANCEL_INVOICE_WITH_REASON: 'cancel-invoice-with-reason',
  CANCEL_ORDER_WITH_REASON: 'cancel-order-with-reason',
  COMPLETE_ORDER: 'complete-order',
  REPRINT_ORDER: 'reprint-order',
  GET_MENU_ITEMS: 'get-menu-items',
  REFRESH_MENU_CACHE: 'refresh-menu-cache',
  SET_MENU_ITEM_ACTIVE: 'set-menu-item-active',
  SET_CATEGORY_ACTIVE: 'set-category-active',
  LIST_TABLES: 'list-tables',
  LIST_MANAGED_TABLES: 'list-managed-tables',
  GET_KOT_BOARD: 'get-kot-board',
  MOVE_KOT: 'move-kot',
  GET_KOT_WORKFLOW: 'get-kot-workflow',
  SAVE_KOT_WORKFLOW: 'save-kot-workflow',
  GET_TAX_RATE: 'get-tax-rate',
  LIST_TAX_RATES: 'list-tax-rates',
  ADD_TAX_RATE: 'add-tax-rate',
  DELETE_TAX_RATE: 'delete-tax-rate',
  GET_MY_ACCESS: 'get-my-access',
  LIST_MENU_CATEGORIES: 'list-menu-categories',
  SAVE_MENU_ITEM: 'save-menu-item',
  PLACE_ORDER: 'place-order',
  SAVE_MANAGED_TABLE: 'save-managed-table',
  DELETE_MANAGED_TABLE: 'delete-managed-table',
  SET_MANAGED_TABLE_STATUS: 'set-managed-table-status',
  SAVE_ORDER_PAYMENT: 'save-order-payment',
  REPRINT_TABLE_BILL: 'reprint-table-bill',
  TEST_PRINT: 'test-print',
  // settings (renderer -> main, invoke)
  GET_SETTINGS: 'get-settings',
  UPDATE_SETTINGS: 'update-settings',
  REMOVE_PRINTER: 'remove-printer',
  GET_MAX_PRINTERS: 'get-max-printers',
  GET_INVOICE_SEQUENCE_STATUS: 'get-invoice-sequence-status',
  RESET_INVOICE_SEQUENCE: 'reset-invoice-sequence',
  // server (renderer -> main, invoke)
  GET_SERVER_STATUS: 'get-server-status',
  LIST_API_DEVICES: 'list-api-devices',
  CREATE_API_DEVICE: 'create-api-device',
  REVOKE_API_DEVICE: 'revoke-api-device',
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
  listGroups(): Promise<UserGroup[]>;
  listPermissions(): Promise<PermissionInfo[]>;
  listGroupMemberships(): Promise<GroupMembership[]>;
  saveGroup(payload: SaveGroupPayload): Promise<string>;
  deleteGroup(groupId: string): Promise<void>;
  setGroupMembers(groupId: string, userIds: string[]): Promise<void>;
  setUserGroups(userId: string, groupIds: string[]): Promise<void>;
  getUserAccess(userId: string): Promise<UserAccessEntry[]>;
  listOrders(filter: OrderListFilter): Promise<OrderListPage>;
  /** Orders List's invoice-grouped row detail — every order sharing that invoice_number, via get_orders_by_invoice(). */
  getInvoiceOrderDetail(invoiceNumber: string): Promise<TableOrderDetail>;
  getInvoiceActivityLog(invoiceNumber: string): Promise<OrderActivityLogEntry[]>;
  editOrderItem(payload: EditOrderItemPayload): Promise<void>;
  deleteOrderItem(orderItemId: string, reason: string, approval: EditorApproval): Promise<void>;
  cancelOrderWithReason(orderId: string, reason: string, approval: EditorApproval): Promise<void>;
  /** Cancel every round of a dine-in invoice at once (one editor approval). */
  cancelInvoiceWithReason(
    invoiceNumber: string,
    reason: string,
    approval: EditorApproval,
  ): Promise<void>;
  completeOrder(orderId: string): Promise<void>;
  reprintOrder(orderId: string): Promise<void>;
  getMenuItems(): Promise<MenuCacheSnapshot>;
  refreshMenuCache(): Promise<MenuCacheSnapshot>;
  setMenuItemActive(menuItemId: string, isActive: boolean): Promise<MenuCacheSnapshot>;
  /** Turn every item of a category on or off (this outlet). categoryId '' = items without a category. */
  setCategoryActive(categoryId: string, isActive: boolean): Promise<MenuCacheSnapshot>;
  listTables(): Promise<TableCard[]>;
  listManagedTables(): Promise<ManagedTable[]>;
  getKotBoard(): Promise<KotBoard>;
  moveKot(orderId: string, toStatusId: string, fromStatusId: string): Promise<void>;
  getKotWorkflow(): Promise<KotWorkflow>;
  saveKotWorkflow(workflow: KotWorkflow): Promise<void>;
  getTaxRate(): Promise<TaxRates>;
  listTaxRates(): Promise<TaxRateRow[]>;
  addTaxRate(payload: AddTaxRatePayload): Promise<void>;
  deleteTaxRate(id: string): Promise<void>;
  getMyAccess(): Promise<MyAccess | null>;
  listMenuCategories(): Promise<MenuCategory[]>;
  saveMenuItem(payload: SaveMenuItemPayload): Promise<MenuCacheSnapshot>;
  placeOrder(payload: PlaceOrderPayload): Promise<PlaceOrderResult>;
  saveManagedTable(payload: SaveManagedTablePayload): Promise<void>;
  deleteManagedTable(tableId: string): Promise<void>;
  /** Quick status toggle from the Tables list; refused while the table has a live order. */
  setManagedTableStatus(tableId: string, status: ManagedTableStatus): Promise<void>;
  savePayment(payload: SavePaymentPayload): Promise<void>;
  reprintTableBill(orderId: string): Promise<void>;
  testPrint(target?: string): Promise<string>;
  getSettings(): Promise<Record<string, string>>;
  updateSettings(printerType: string, deviceName: string): Promise<void>;
  removePrinter(printerType: string): Promise<void>;
  getMaxPrinters(): Promise<number>;
  getInvoiceSequenceStatus(): Promise<InvoiceSequenceStatus | null>;
  resetInvoiceSequence(): Promise<void>;
  getServerStatus(): Promise<ServerStatus>;
  listApiDevices(): Promise<ApiDevice[]>;
  createApiDevice(name: string): Promise<CreatedApiDevice>;
  revokeApiDevice(id: string): Promise<void>;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
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
