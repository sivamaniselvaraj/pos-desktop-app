/**
 * data/ports.ts
 * ---------------------------------------------------------------------------
 * The data-access contract of the desktop app. Managers (orderManager,
 * tablesManager, ...) talk ONLY to these interfaces, through `db` from
 * ./index. They never import a database SDK, never see a table or column
 * name, and never see a vendor error code.
 *
 * To move to another database, implement DataProvider in a new folder
 * (data/<name>/), register it in ./index.ts and set DB_PROVIDER=<name>.
 * Nothing outside src/main/data changes.
 *
 * Conventions every implementation must follow:
 *  - Methods return the domain types from shared/types (camelCase), never
 *    raw rows.
 *  - Failures throw Error with a message fit to show the user.
 *  - "Not found" is null (single items) or [] (lists), not an exception,
 *    unless a method says otherwise.
 *  - Authorization (who may do what) is the implementation's job: e.g. the
 *    Supabase provider relies on RLS and security-definer functions. Another
 *    provider must enforce the same rules (see db/ docs) in its own way.
 * ---------------------------------------------------------------------------
 */
import type {
  UserGroup,
  PermissionInfo,
  GroupMembership,
  SaveGroupPayload,
  UserAccessEntry,
  FoodOrder,
  OrderItem,
  OutletInfo,
  ReportBucket,
  SalesReportRow,
  TopItemRow,
  SalesByOrderTypeRow,
  SalesByTypeBucketRow,
  OrderListPage,
  OrderListFilter,
  OrderDetailItem,
  OrderActivityLogEntry,
  EditorApproval,
  TableCard,
  ManagedTable,
  ManagedTableStatus,
  SavePaymentPayload,
  MenuCategory,
  TaxRate,
  MyAccess,
  ManagedUser,
  OutletOption,
  CreateUserPayload,
  UpdateUserPayload,
  InvoiceSequenceStatus,
} from '../../shared/types';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
export interface SessionUser {
  id: string;
  email: string;
}

export interface UserProfile {
  id: string;
  email: string | null;
  fullName: string | null;
  role: string | null;
  isActive: boolean | null;
  outletId: string | null;
}

export interface AuthRepository {
  /** Email + password sign in. Never throws for bad credentials. */
  signIn(email: string, password: string): Promise<{ ok: true; user: SessionUser } | { ok: false; error: string }>;
  signOut(): Promise<void>;
  /** The persisted session's user, or null when nobody is signed in. */
  getSessionUser(): Promise<SessionUser | null>;
  /** The signed-in user's own profile; null when missing. */
  loadProfile(userId: string): Promise<UserProfile | null>;
  loadOutletName(outletId: string): Promise<string | undefined>;
}

export interface AccessRepository {
  /** Permissions + menus + organization settings. null when the backend can't provide it (older database). */
  fetchMyAccess(): Promise<MyAccess | null>;
  /** The signed-in user's role, used for the built-in fallback rules. null when not signed in. */
  fetchSessionRole(): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Orders: print / settle path (also used by the mobile HTTP API)
// ---------------------------------------------------------------------------
export interface TableBatch {
  tableId: string | null;
  orderIds: string[];
  orderNumbers: number[];
  /** orderIds and orderNumbers zipped, sorted by orderNumber. */
  orders: { id: string; orderNumber: number }[];
}

export interface OrderRepository {
  isReachable(): Promise<boolean>;
  fetchOrderById(orderId: string): Promise<FoodOrder | null>;
  fetchOutletById(outletId: string): Promise<OutletInfo | null>;
  getOrderStatus(orderId: string): Promise<string | null>;
  /** True only when the order exists AND belongs to this outlet. Unknown or malformed ids are false. */
  isOrderInOutlet(orderId: string, outletId: string): Promise<boolean>;
  /** Items not yet sent to the kitchen. */
  fetchUnprintedItems(orderId: string): Promise<OrderItem[]>;
  markItemsKotPrinted(itemIds: string[]): Promise<void>;
  /** Non-deleted items merged by dish (2 + 3 of the same dish = 5). */
  fetchAggregatedItems(orderId: string): Promise<OrderItem[]>;
  fetchAggregatedItemsForOrders(orderIds: string[]): Promise<OrderItem[]>;
  /** Every order of the same table that is still part of the current settle batch. */
  fetchTableBatchOrders(orderId: string): Promise<TableBatch>;
  /** Order numbers in a dine-in table's batch; null when the table doesn't exist. */
  fetchTableOrderNumbers(tableNumber: string, outletId: string): Promise<number[] | null>;
  fetchOrdersByNumbers(orderNumbers: number[], outletId: string): Promise<FoodOrder[]>;
  /** Marks orders completed (settled). Does not free the table. */
  markOrdersCompleted(orderIds: string[]): Promise<void>;
  /** Orders of one outlet whose kitchen items are still unprinted. */
  findOrdersWithPendingKot(): Promise<{ orderId: string; orderType: string }[]>;
}

// ---------------------------------------------------------------------------
// Orders list page (manager/owner/admin)
// ---------------------------------------------------------------------------
export interface InvoiceOrderRef {
  id: string;
  orderNumber: number;
  status: string;
}

export type InvoiceItemRecord = Omit<OrderDetailItem, 'orderNumber' | 'orderId'> & { orderId: string };
export type ActivityLogRecord = Omit<OrderActivityLogEntry, 'orderNumber'>;

export interface OrderAdminRepository {
  listOrders(outletId: string, filter: OrderListFilter): Promise<OrderListPage>;
  listInvoiceOrders(invoiceNumber: string): Promise<InvoiceOrderRef[]>;
  listItemsForOrders(orderIds: string[]): Promise<InvoiceItemRecord[]>;
  getOrderActivityLog(orderId: string): Promise<ActivityLogRecord[]>;
  /** True when the item exists and its order is still open. */
  isItemEditable(orderItemId: string): Promise<boolean>;
  editItem(args: {
    outletId: string;
    orderItemId: string;
    quantity: number;
    reason: string;
    approval?: EditorApproval;
  }): Promise<void>;
  deleteItem(args: { outletId: string; orderItemId: string; reason: string; approval: EditorApproval }): Promise<void>;
  cancelOrder(args: { outletId: string; orderId: string; reason: string; approval: EditorApproval }): Promise<void>;
  cancelInvoice(args: {
    outletId: string;
    invoiceNumber: string;
    reason: string;
    approval: EditorApproval;
  }): Promise<void>;
  completeOrder(orderId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Order entry (New Order page)
// ---------------------------------------------------------------------------
export interface NewOrderLine {
  menuItemId: string;
  unitPrice: number;
  totalPrice: number;
  quantity: number;
}

export interface OrderEntryRepository {
  getTaxRate(outletId: string): Promise<TaxRate>;
  placeDineInOrder(args: {
    outletId: string;
    tableId: string;
    items: NewOrderLine[];
    subtotal: number;
    tax: number;
    total: number;
  }): Promise<string>;
  placePickupOrder(args: {
    outletId: string;
    items: NewOrderLine[];
    subtotal: number;
    tax: number;
    containerCharge: number;
    total: number;
    customerName: string | null;
    customerPhone: string | null;
    notes: string | null;
  }): Promise<string>;
  /** Best effort details for the confirmation. */
  getOrderSummary(orderId: string): Promise<{ orderNumber?: number; invoiceNumber?: string }>;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------
export interface TableValues {
  tableNumber: string;
  floorArea: string | null;
  capacity: number | null;
  status: ManagedTableStatus;
}

export interface TableRepository {
  /** Dashboard cards: each table with its current batch. */
  listCards(): Promise<TableCard[]>;
  savePayment(payload: SavePaymentPayload): Promise<void>;
  /** Tables of an outlet with live order counts (unsorted). */
  listManaged(outletId: string): Promise<ManagedTable[]>;
  listTableNumbers(outletId: string): Promise<{ id: string; tableNumber: string }[]>;
  insert(outletId: string, values: TableValues): Promise<void>;
  /** Throws 'Table not found in this outlet' when nothing was updated. */
  update(outletId: string, tableId: string, values: TableValues): Promise<void>;
  countOrdersForTable(tableId: string): Promise<number>;
  remove(outletId: string, tableId: string): Promise<void>;
  /** null when the table isn't in this outlet. */
  getStatus(outletId: string, tableId: string): Promise<ManagedTableStatus | null>;
  /** Number of live (not cancelled, not yet paid) orders on a table. */
  liveOrderCount(outletId: string, tableId: string): Promise<number>;
  setStatus(outletId: string, tableId: string, status: ManagedTableStatus): Promise<void>;
  /** Status of any table by id (used when placing an order). */
  getStatusById(tableId: string): Promise<ManagedTableStatus | null>;
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------
export interface MenuItemValues {
  name: string;
  categoryId: string;
  price: number;
  description: string | null;
  isVeg: boolean;
  containerCharge: number | null;
  costPrice: number | null;
  searchKey: string | null;
  cookingTime: number;
  sortOrder: number;
  imageUrl: string | null;
  isAvailable: boolean;
  isActive: boolean;
}

export interface MenuRepository {
  /** The outlet's full menu as raw items plus category_id / category_name. Works without a signed-in user. */
  fetchMenu(outletId: string): Promise<Record<string, unknown>[]>;
  setItemActive(menuItemId: string, isActive: boolean): Promise<void>;
  listCategories(): Promise<MenuCategory[]>;
  /** Ids of items in this outlet whose name equals `name`, ignoring case. */
  findItemIdsByName(outletId: string, name: string): Promise<string[]>;
  insertItem(outletId: string, values: MenuItemValues): Promise<void>;
  /** Throws 'Not allowed, or the item no longer exists.' when nothing was updated. */
  updateItem(outletId: string, id: string, values: MenuItemValues): Promise<void>;
}

// ---------------------------------------------------------------------------
// Users, invoicing, reports
// ---------------------------------------------------------------------------
export interface UserRepository {
  listUsers(): Promise<ManagedUser[]>;
  listOutlets(): Promise<OutletOption[]>;
  create(payload: CreateUserPayload): Promise<void>;
  update(payload: UpdateUserPayload): Promise<void>;
  setActive(userId: string, isActive: boolean): Promise<void>;
}

/** User groups: named permission bundles whose members inherit them (identity-management style). */
export interface GroupRepository {
  listGroups(): Promise<UserGroup[]>;
  listPermissions(): Promise<PermissionInfo[]>;
  listMemberships(): Promise<GroupMembership[]>;
  /** Creates (no id) or updates a group and replaces its permissions. Returns the id. */
  save(payload: SaveGroupPayload): Promise<string>;
  delete(groupId: string): Promise<void>;
  setMembers(groupId: string, userIds: string[]): Promise<void>;
  setUserGroups(userId: string, groupIds: string[]): Promise<void>;
  /** Every permission with where it comes from (role / group names); empty `via` = not granted. */
  userAccess(userId: string): Promise<UserAccessEntry[]>;
}

export interface InvoiceRepository {
  getSequenceStatus(): Promise<InvoiceSequenceStatus | null>;
  resetSequence(): Promise<void>;
}

export interface ReportRepository {
  salesReport(from: string, to: string, bucket: ReportBucket): Promise<SalesReportRow[]>;
  topItems(from: string, to: string, limit: number): Promise<TopItemRow[]>;
  salesByOrderType(from: string, to: string): Promise<SalesByOrderTypeRow[]>;
  salesByTypeBucketed(from: string, to: string, bucket: ReportBucket): Promise<SalesByTypeBucketRow[]>;
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------
export interface DataProvider {
  readonly name: string;
  /** True when the backend's connection settings are present. */
  isConfigured(): boolean;
  auth: AuthRepository;
  access: AccessRepository;
  orders: OrderRepository;
  orderAdmin: OrderAdminRepository;
  orderEntry: OrderEntryRepository;
  tables: TableRepository;
  menu: MenuRepository;
  users: UserRepository;
  groups: GroupRepository;
  invoices: InvoiceRepository;
  reports: ReportRepository;
}
