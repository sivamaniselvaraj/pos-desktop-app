// IPC contract: channel names and the window.api shape exposed by the preload bridge.
// Imported by the main process, the preload script and the renderer (window.api).

import type { ConnectionSetupInput, ConnectionSetupResult, ConnectionSetupStatus } from './connectionTypes';
import type {
  ReportBucket,
  SalesReportRow,
  MenuAvailabilityReport,
  SalesByWaiterRow,
  VoidsDiscountsReport,
  TopItemRow,
  SalesByOrderTypeRow,
  SalesByTypeBucketRow,
  ShiftWindow,
  DailySummaryReport,
  HourlySalesReport,
  ProductMixReport,
  ChannelSalesReport,
  SalesReportExportPayload,
  MenuExportPayload,
  ExportResult,
} from './reportTypes';
import type {MenuUploadLogBatch, MenuUploadPickResult, MenuUploadSummary } from './menuUploadTypes';
import type {
  ReceiptText,
  OrderWithStatus,
  ApiDevice,
  PairingCode,
  PrintMethod,
  UnprintedKot,
  PrintOrderResponse,
  ManagedUser,
  PermissionInfo,
  UserGroup,
  SaveGroupPayload,
  GroupMembership,
  UserAccessEntry,
  OutletOption,
  InvoiceSequenceStatus,
  OrderListPage,
  ActiveTakeawayList,
  OrderListFilter,
  EditorApproval,
  EditOrderItemPayload,
  TableOrderDetail,
  OrderActivityLogEntry,
  MenuItemRecord,
  MyAccess,
  MenuCategory,
  MenuCategoryAdmin,
  DiscountPreset,
  DiscountSettings,
  DiscountOptions,
  SetOrderDiscountPayload,
  SaveMenuItemPayload,
  PlaceOrderPayload,
  PlaceOrderResult,
  TaxRates,
  TaxRateRow,
  AddTaxRatePayload,
  KotBoard,
  KotWorkflow,
  ManagedTableStatus,
  ManagedTable,
  SaveManagedTablePayload,
  TableCard,
  SavePaymentPayload,
  MenuCacheSnapshot,
  CreateUserPayload,
  UpdateUserPayload,
  PrinterInfo,
  ServerStatus,
  AuthUser,
  AuthResult,
  UpdateChannel,
  UpdateStatus,
  InstallCheck,
} from './types';

// ---- IPC channel names (single source of truth) ----
export const IpcChannels = {
  // auth (renderer -> main, invoke)
  AUTH_SIGN_IN: 'auth:sign-in',
  AUTH_SIGN_OUT: 'auth:sign-out',
  AUTH_GET_SESSION: 'auth:get-session',
  // connection setup (renderer -> main, invoke)
  SETUP_GET_STATUS: 'setup:get-status',
  SETUP_SAVE: 'setup:save',
  // orders (renderer -> main, invoke)
  GET_ORDERS: 'get-orders',
  RETRY_PRINT: 'retry-print',
  CANCEL_ORDER: 'cancel-order',
  CLEAR_PRINTED: 'clear-printed',
  // printers (renderer -> main, invoke)
  GET_PRINTERS: 'get-printers',
  GET_PRINT_METHOD: 'get-print-method',
  SET_PRINT_METHOD: 'set-print-method',
  GET_PRINTER_ADDRESSES: 'get-printer-addresses',
  GET_PRINTER_SETUPS: 'get-printer-setups',
  SAVE_PRINTER_SETUPS: 'save-printer-setups',
  TEST_PRINTER_SETUP: 'test-printer-setup',
  SET_PRINTER_ADDRESS: 'set-printer-address',
  GET_SALES_REPORT: 'get-sales-report',
  GET_SALES_BY_WAITER: 'get-sales-by-waiter',
  GET_MENU_AVAILABILITY: 'get-menu-availability',
  GET_VOIDS_DISCOUNTS: 'get-voids-discounts',
  GET_TOP_ITEMS: 'get-top-items',
  GET_SALES_BY_ORDER_TYPE: 'get-sales-by-order-type',
  GET_SALES_BY_TYPE_BUCKETED: 'get-sales-by-type-bucketed',
  GET_DAILY_SUMMARY: 'get-daily-summary',
  GET_SALES_BY_HOUR: 'get-sales-by-hour',
  GET_PRODUCT_MIX: 'get-product-mix',
  GET_SALES_BY_CHANNEL: 'get-sales-by-channel',
  EXPORT_SALES_REPORT: 'export-sales-report',
  EXPORT_MENU_ITEMS: 'export-menu-items',
  PICK_MENU_UPLOAD_FILE: 'pick-menu-upload-file',
  COMMIT_MENU_UPLOAD: 'commit-menu-upload',
  SAVE_MENU_UPLOAD_ERRORS: 'save-menu-upload-errors',
  GET_MENU_UPLOAD_LOG: 'get-menu-upload-log',
  DOWNLOAD_MENU_TEMPLATE: 'download-menu-template',
  DOWNLOAD_CURRENT_MENU: 'download-current-menu',
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
  GET_ORDER_KOT_SETUP: 'get-order-kot-setup',
  LIST_ORDERS_LIVE: 'list-orders-live',
  LIST_ACTIVE_TAKEAWAY: 'list-active-takeaway',
  GET_INVOICE_ORDER_DETAIL: 'get-invoice-order-detail',
  GET_INVOICE_ACTIVITY_LOG: 'get-invoice-activity-log',
  GET_INVOICE_ORDER_VIEW: 'get-invoice-order-view',
  EDIT_ORDER_ITEM: 'edit-order-item',
  DELETE_ORDER_ITEM: 'delete-order-item',
  CANCEL_INVOICE_WITH_REASON: 'cancel-invoice-with-reason',
  CANCEL_ORDER_WITH_REASON: 'cancel-order-with-reason',
  SET_ORDER_DISCOUNT: 'set-order-discount',
  GET_DISCOUNT_OPTIONS: 'get-discount-options',
  GET_DISCOUNT_SETTINGS: 'get-discount-settings',
  SAVE_DISCOUNT_PRESETS: 'save-discount-presets',
  COMPLETE_ORDER: 'complete-order',
  COMPLETE_INVOICE: 'complete-invoice',
  REPRINT_ORDER: 'reprint-order',
  GET_MENU_ITEMS: 'get-menu-items',
  REFRESH_MENU_CACHE: 'refresh-menu-cache',
  SET_MENU_ITEM_ACTIVE: 'set-menu-item-active',
  SET_CATEGORY_ACTIVE: 'set-category-active',
  SET_MENU_ITEMS_ACTIVE: 'set-menu-items-active',
  LIST_TABLES: 'list-tables',
  LIST_MANAGED_TABLES: 'list-managed-tables',
  GET_KOT_BOARD: 'get-kot-board',
  GET_UNPRINTED_KOTS: 'get-unprinted-kots',
  PRINT_KOT_NOW: 'print-kot-now',
  MOVE_KOT: 'move-kot',
  MOVE_KOT_ITEMS: 'move-kot-items',
  GET_KOT_WORKFLOW: 'get-kot-workflow',
  SAVE_KOT_WORKFLOW: 'save-kot-workflow',
  GET_TAX_RATE: 'get-tax-rate',
  LIST_TAX_RATES: 'list-tax-rates',
  ADD_TAX_RATE: 'add-tax-rate',
  DELETE_TAX_RATE: 'delete-tax-rate',
  GET_MY_ACCESS: 'get-my-access',
  SAVE_BRAND_COLOR: 'save-brand-color',
  GET_RECEIPT_TEXT: 'get-receipt-text',
  SAVE_RECEIPT_TEXT: 'save-receipt-text',
  LIST_MENU_CATEGORIES: 'list-menu-categories',
  LIST_MENU_CATEGORIES_ADMIN: 'list-menu-categories-admin',
  SAVE_MENU_CATEGORY: 'save-menu-category',
  REORDER_MENU_CATEGORIES: 'reorder-menu-categories',
  SET_MENU_CATEGORY_ACTIVE: 'set-menu-category-active',
  SAVE_MENU_ITEM: 'save-menu-item',
  GET_MENU_ITEM: 'get-menu-item',
  PLACE_ORDER: 'place-order',
  LIST_TAKEAWAY_DRAFTS: 'list-takeaway-drafts',
  SAVE_TAKEAWAY_DRAFT: 'save-takeaway-draft',
  DELETE_TAKEAWAY_DRAFT: 'delete-takeaway-draft',
  SAVE_MANAGED_TABLE: 'save-managed-table',
  DELETE_MANAGED_TABLE: 'delete-managed-table',
  SET_MANAGED_TABLE_STATUS: 'set-managed-table-status',
  SAVE_ORDER_PAYMENT: 'save-order-payment',
  REPRINT_TABLE_BILL: 'reprint-table-bill',
  SETTLE_TABLE_BILL: 'settle-table-bill',
  TEST_PRINT: 'test-print',
  PROBE_CODEPAGES: 'probe-codepages',
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
  CREATE_PAIRING_CODE: 'create-pairing-code',
  CANCEL_PAIRING_CODE: 'cancel-pairing-code',
  REVOKE_API_DEVICE: 'revoke-api-device',
  RESET_API_DEVICE_PIN: 'reset-api-device-pin',
  // main -> renderer (send)
  ORDER_RECEIVED: 'order-received',
  ORDER_STATUS_CHANGED: 'order-status-changed',
  PRINTER_STATUS: 'printer-status',
  SERVER_STATUS: 'server-status',
  // app updates (see docs/APP_UPDATES.md)
  GET_UPDATE_STATUS: 'get-update-status',
  CHECK_FOR_UPDATES: 'check-for-updates',
  GET_INSTALL_CHECK: 'get-install-check',
  INSTALL_UPDATE: 'install-update',
  SET_UPDATE_CHANNEL: 'set-update-channel',
  UPDATE_STATUS: 'update-status', // main -> renderer (send)
} as const;

// Shape exposed on window.api by the preload bridge.
export interface ElectronApi {
  signIn(email: string, password: string): Promise<AuthResult>;
  signOut(): Promise<void>;
  getSession(): Promise<AuthUser | null>;
  /** Database URL, token (presence only) and outlet id of this PC. */
  getConnectionSetup(): Promise<ConnectionSetupStatus>;
  /** Saves the setup screen; on success the app restarts. */
  saveConnectionSetup(input: ConnectionSetupInput): Promise<ConnectionSetupResult>;
  getOrders(): Promise<OrderWithStatus[]>;
  retryPrint(orderId: string): Promise<PrintOrderResponse>;
  cancelOrder(orderId: string): Promise<void>;
  clearPrinted(): Promise<void>;
  /** OS printers (cached 60 s in main); `refresh` reads the OS again. */
  getPrinters(refresh?: boolean): Promise<PrinterInfo[]>;
  /** 'direct' = ESC/POS (default), 'html' = HTML via the OS driver. */
  getPrintMethod(): Promise<PrintMethod>;
  setPrintMethod(method: PrintMethod): Promise<void>;
  /** Image method only: network address ("192.168.1.50" or "192.168.1.50:9100") per OS printer name. */
  getPrinterAddresses(): Promise<Record<string, string>>;
  /** Empty address removes it (the job then goes through the Windows spooler). */
  setPrinterAddress(printerName: string, address: string): Promise<void>;
  getSalesReport(outletId: string, from: string, to: string, bucket: ReportBucket): Promise<SalesReportRow[]>;
  getSalesByWaiter(outletId: string, from: string, to: string): Promise<SalesByWaiterRow[]>;
  getMenuAvailability(outletId: string, from: string, to: string): Promise<MenuAvailabilityReport>;
  /** Every void, cancellation and discount in the range, with who and why. */
  getVoidsDiscounts(outletId: string, from: string, to: string): Promise<VoidsDiscountsReport>;
  getTopItems(outletId: string, from: string, to: string): Promise<TopItemRow[]>;
  getSalesByOrderType(outletId: string, from: string, to: string): Promise<SalesByOrderTypeRow[]>;
  getSalesByTypeBucketed(
    outletId: string, 
    from: string,
    to: string,
    bucket: ReportBucket,
  ): Promise<SalesByTypeBucketRow[]>;
  exportSalesReport(payload: SalesReportExportPayload): Promise<ExportResult>;
  /** Save the Menu Items list as Excel or CSV (the operator picks the file and type). */
  exportMenuItems(payload: MenuExportPayload): Promise<ExportResult>;
  /** Settings > Menu upload (needs menu.upload; docs/MENU_UPLOAD.md). Opens a file dialog, reads the file and returns the preview. Nothing is saved. */
  pickMenuUploadFile(): Promise<MenuUploadPickResult>;
  /** Saves the New and Update rows of the preview in one go (all or nothing). The token comes from the preview. */
  commitMenuUpload(token: string): Promise<MenuUploadSummary>;
  /** Saves the preview's rows with errors as a file (Excel or CSV). */
  saveMenuUploadErrors(token: string): Promise<ExportResult>;
  /** Recent menu uploads (items created or updated, never errors). Needs menu.upload. */
  getMenuUploadLog(): Promise<MenuUploadLogBatch[]>;
  /** The empty menu file (column names, and a Help sheet in Excel). */
  downloadMenuTemplate(): Promise<ExportResult>;
  /** The whole menu of this outlet in the upload format. */
  downloadCurrentMenu(): Promise<ExportResult>;
  /** Daily summary / Z-report; shift = optional time-of-day window. */
  getDailySummary(outletId: string, from: string, to: string, shift?: ShiftWindow | null): Promise<DailySummaryReport>;
  getSalesByHour(outletId: string, from: string, to: string): Promise<HourlySalesReport>;
  getProductMix(outletId: string, from: string, to: string): Promise<ProductMixReport>;
  getSalesByChannel(outletId: string, from: string, to: string): Promise<ChannelSalesReport>;
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
   /** Dashboard Takeaway tab: open takeaway / pickup / delivery orders of this outlet, oldest first; needs orders.view. */
  listActiveTakeaway(): Promise<ActiveTakeawayList>;
  
  /** Orders List's invoice-grouped row detail — every order sharing that invoice_number, via get_orders_by_invoice(). */
  getInvoiceOrderDetail(invoiceNumber: string): Promise<TableOrderDetail>;
  getInvoiceActivityLog(invoiceNumber: string): Promise<OrderActivityLogEntry[]>;
  editOrderItem(payload: EditOrderItemPayload): Promise<void>;
  deleteOrderItem(orderItemId: string, reason: string, approval: EditorApproval): Promise<void>;
  cancelOrderWithReason(orderId: string, reason: string, approval: EditorApproval): Promise<void>;
  /** Discount an order (or all rounds of a table) or mark it complimentary. Needs orders.discount. */
  setOrderDiscount(payload: SetOrderDiscountPayload): Promise<void>;
  /** The discount percentages and limits the user may use. */
  getDiscountOptions(): Promise<DiscountOptions>;
  /** Settings > Discounts (needs discount.manage). */
  getDiscountSettings(): Promise<DiscountSettings>;
  saveDiscountPresets(presets: DiscountPreset[]): Promise<void>;
  /** Cancel every round of a dine-in invoice at once (one editor approval). */
  cancelInvoiceWithReason(
    invoiceNumber: string,
    reason: string,
    approval: EditorApproval,
  ): Promise<void>;
  completeOrder(orderId: string): Promise<void>;
  /** Complete every open round of an invoice. Resolves with how many orders were completed. */
  completeInvoice(invoiceNumber: string): Promise<number>;
  reprintOrder(invoiceNumber: string): Promise<void>;
  getMenuItems(): Promise<MenuCacheSnapshot>;
  refreshMenuCache(): Promise<MenuCacheSnapshot>;
  /** `reason` is required when turning off. */
  setMenuItemActive(menuItemId: string, isActive: boolean, reason?: string): Promise<MenuCacheSnapshot>;
  /** Turn the selected items on or off in ONE database call. Items already in that state are skipped. `reason` is required when turning off. */
  setMenuItemsActive(menuItemIds: string[], isActive: boolean, reason?: string): Promise<MenuCacheSnapshot>;
  /** Turn every item of a category on or off (this outlet). categoryId '' = items without a category. */
  setCategoryActive(categoryId: string, isActive: boolean, reason?: string): Promise<MenuCacheSnapshot>;
  listTables(): Promise<TableCard[]>;
  listManagedTables(): Promise<ManagedTable[]>;
  getKotBoard(userId: string): Promise<KotBoard>;
  getUnprintedKots(): Promise<UnprintedKot[]>;
  /** Print the order's unprinted kitchen items now. Rejects with the printer's message on failure. */
  printKotNow(orderId: string): Promise<string>;
  moveKot(orderId: string, toStatusId: string, fromStatusId: string, userId: string): Promise<void>;
  /** KDS board: move only these dishes of the order from one step to another (never to 'cancelled'). */
  moveKotItems(orderId: string, itemIds: string[], toStatusId: string, fromStatusId: string, userId: string): Promise<void>;
  getKotWorkflow(): Promise<KotWorkflow>;
  saveKotWorkflow(workflow: KotWorkflow): Promise<void>;
  getTaxRate(): Promise<TaxRates>;
  listTaxRates(): Promise<TaxRateRow[]>;
  addTaxRate(payload: AddTaxRatePayload): Promise<void>;
  deleteTaxRate(id: string): Promise<void>;
  getMyAccess(): Promise<MyAccess | null>;
  /** The signed-in outlet's custom bill header/footer lines. */
  getReceiptText(): Promise<ReceiptText>;
  /** Needs receipt.manage. Blank = print the outlet's address / phone / GST as before. */
  saveReceiptText(text: ReceiptText): Promise<ReceiptText>;
  /** Set the business's app colour (#rrggbb), or null for the default. Needs branding.manage. Returns the saved colour. */
  saveBrandColor(color: string | null): Promise<string | null>;
  /** Active categories of this outlet, for pickers. */
  listMenuCategories(): Promise<MenuCategory[]>;
  /** Every category of this outlet with item counts (needs menu.categories). */
  listMenuCategoriesAdmin(): Promise<MenuCategoryAdmin[]>;
  /** Add (no id) or rename a category (needs menu.categories). */
  saveMenuCategory(payload: { id?: string; name: string }): Promise<void>;
  /** Saves the display order: every category id of this outlet, in the wanted order (needs menu.categories.manage). */
  reorderMenuCategories(ids: string[]): Promise<void>;
  /** Deactivating turns the category's items off; activating leaves them off. Returns how many were turned off. */
  setMenuCategoryActive(id: string, isActive: boolean): Promise<{ itemsTurnedOff: number }>;
  saveMenuItem(payload: SaveMenuItemPayload): Promise<MenuCacheSnapshot>;
  /** The whole row of one item (the list carries only some columns); for the Edit form. */
  getMenuItem(id: string): Promise<MenuItemRecord>;
  placeOrder(payload: PlaceOrderPayload): Promise<PlaceOrderResult>;
  saveManagedTable(payload: SaveManagedTablePayload): Promise<void>;
  deleteManagedTable(tableId: string): Promise<void>;
  /** Quick status toggle from the Tables list; refused while the table has a live order. */
  setManagedTableStatus(tableId: string, status: ManagedTableStatus): Promise<void>;
  savePayment(payload: SavePaymentPayload): Promise<void>;
  testPrint(target?: string): Promise<string>;
  getSettings(): Promise<Record<string, string>>;
  updateSettings(printerType: string, deviceName: string): Promise<void>;
  removePrinter(printerType: string): Promise<void>;
  getMaxPrinters(): Promise<number>;
  getInvoiceSequenceStatus(): Promise<InvoiceSequenceStatus | null>;
  resetInvoiceSequence(): Promise<void>;
  getServerStatus(): Promise<ServerStatus>;
  listApiDevices(): Promise<ApiDevice[]>;
  createPairingCode(): Promise<PairingCode>;
  cancelPairingCode(): Promise<void>;
  revokeApiDevice(id: string): Promise<void>;
  /** Clears the app PIN on a phone; the user sets a new one the next time they open the app. */
  resetApiDevicePin(id: string): Promise<void>;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  onOrderReceived(cb: (order: OrderWithStatus) => void): () => void;
  onOrderStatusChanged(cb: (order: OrderWithStatus) => void): () => void;
  onPrinterStatus(cb: (printers: PrinterInfo[]) => void): () => void;
  onServerStatus(cb: (status: ServerStatus) => void): () => void;
  getUpdateStatus(): Promise<UpdateStatus>;
  /** Check now (About page). Resolves with the status after the check starts. */
  checkForUpdates(): Promise<UpdateStatus>;
  getInstallCheck(): Promise<InstallCheck>;
  /** Close the app, install the downloaded version and reopen it. */
  installUpdate(): Promise<void>;
  /** Beta = this PC gets releases a few days early (saved in settings.json). */
  setUpdateChannel(channel: UpdateChannel): Promise<UpdateStatus>;
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void;
}

declare global {
  interface Window {
    api: ElectronApi;
  }
}
