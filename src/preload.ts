import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels } from './shared/types';
import type {
  AuthResult,
  AuthUser,
  ElectronApi,
  OrderWithStatus,
  PrinterInfo,
  PrintOrderResponse,
  SalesReportRow,
  TopItemRow,
  SalesByOrderTypeRow,
  SalesByTypeBucketRow,
  ExportResult,
  ManagedUser,
  UserGroup,
  PermissionInfo,
  GroupMembership,
  UserAccessEntry,
  OutletOption,
  OrderListPage,
  OrderActivityLogEntry,
  MenuCacheSnapshot,
  TableCard,
  ManagedTable,
  TaxRates,
  TaxRateRow,
  AddTaxRatePayload,
  MyAccess,
  MenuCategory,
  PlaceOrderResult,
  ServerStatus,
  ApiDevice,
  CreatedApiDevice,
  SavePaymentPayload,
  TableOrderDetail,
  InvoiceSequenceStatus,
} from './shared/types.js';

// Helper to subscribe to a main->renderer channel and return an unsubscribe fn.
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: ElectronApi = {
  signIn: (email, password) =>
    ipcRenderer.invoke(IpcChannels.AUTH_SIGN_IN, email, password) as Promise<AuthResult>,
  signOut: () => ipcRenderer.invoke(IpcChannels.AUTH_SIGN_OUT) as Promise<void>,
  getSession: () => ipcRenderer.invoke(IpcChannels.AUTH_GET_SESSION) as Promise<AuthUser | null>,
  getOrders: () => ipcRenderer.invoke(IpcChannels.GET_ORDERS) as Promise<OrderWithStatus[]>,
  retryPrint: (orderId) =>
    ipcRenderer.invoke(IpcChannels.RETRY_PRINT, orderId) as Promise<PrintOrderResponse>,
  cancelOrder: (orderId) => ipcRenderer.invoke(IpcChannels.CANCEL_ORDER, orderId) as Promise<void>,
  clearPrinted: () => ipcRenderer.invoke(IpcChannels.CLEAR_PRINTED) as Promise<void>,
  getPrinters: () => ipcRenderer.invoke(IpcChannels.GET_PRINTERS) as Promise<PrinterInfo[]>,
  getSalesReport: (from, to, bucket) =>
    ipcRenderer.invoke(IpcChannels.GET_SALES_REPORT, from, to, bucket) as Promise<SalesReportRow[]>,
  getTopItems: (from, to) =>
    ipcRenderer.invoke(IpcChannels.GET_TOP_ITEMS, from, to) as Promise<TopItemRow[]>,
  getSalesByOrderType: (from, to) =>
    ipcRenderer.invoke(IpcChannels.GET_SALES_BY_ORDER_TYPE, from, to) as Promise<
      SalesByOrderTypeRow[]
    >,
  getSalesByTypeBucketed: (from, to, bucket) =>
    ipcRenderer.invoke(IpcChannels.GET_SALES_BY_TYPE_BUCKETED, from, to, bucket) as Promise<
      SalesByTypeBucketRow[]
    >,
  exportSalesReport: (payload) =>
    ipcRenderer.invoke(IpcChannels.EXPORT_SALES_REPORT, payload) as Promise<ExportResult>,
  listUsers: () => ipcRenderer.invoke(IpcChannels.LIST_USERS) as Promise<ManagedUser[]>,
  listOutlets: () => ipcRenderer.invoke(IpcChannels.LIST_OUTLETS) as Promise<OutletOption[]>,
  createUser: (payload) => ipcRenderer.invoke(IpcChannels.CREATE_USER, payload) as Promise<void>,
  updateUser: (payload) => ipcRenderer.invoke(IpcChannels.UPDATE_USER, payload) as Promise<void>,
  setUserActive: (userId, isActive) =>
    ipcRenderer.invoke(IpcChannels.SET_USER_ACTIVE, userId, isActive) as Promise<void>,
  listGroups: () => ipcRenderer.invoke(IpcChannels.LIST_GROUPS) as Promise<UserGroup[]>,
  listPermissions: () =>
    ipcRenderer.invoke(IpcChannels.LIST_PERMISSIONS) as Promise<PermissionInfo[]>,
  listGroupMemberships: () =>
    ipcRenderer.invoke(IpcChannels.LIST_GROUP_MEMBERSHIPS) as Promise<GroupMembership[]>,
  saveGroup: (payload) => ipcRenderer.invoke(IpcChannels.SAVE_GROUP, payload) as Promise<string>,
  deleteGroup: (groupId) => ipcRenderer.invoke(IpcChannels.DELETE_GROUP, groupId) as Promise<void>,
  setGroupMembers: (groupId, userIds) =>
    ipcRenderer.invoke(IpcChannels.SET_GROUP_MEMBERS, groupId, userIds) as Promise<void>,
  setUserGroups: (userId, groupIds) =>
    ipcRenderer.invoke(IpcChannels.SET_USER_GROUPS, userId, groupIds) as Promise<void>,
  getUserAccess: (userId) =>
    ipcRenderer.invoke(IpcChannels.GET_USER_ACCESS, userId) as Promise<UserAccessEntry[]>,
  listOrders: (filter) =>
    ipcRenderer.invoke(IpcChannels.LIST_ORDERS, filter) as Promise<OrderListPage>,
  getInvoiceOrderDetail: (invoiceNumber) =>
    ipcRenderer.invoke(
      IpcChannels.GET_INVOICE_ORDER_DETAIL,
      invoiceNumber,
    ) as Promise<TableOrderDetail>,
  getInvoiceActivityLog: (invoiceNumber) =>
    ipcRenderer.invoke(IpcChannels.GET_INVOICE_ACTIVITY_LOG, invoiceNumber) as Promise<
      OrderActivityLogEntry[]
    >,
  editOrderItem: (payload) =>
    ipcRenderer.invoke(IpcChannels.EDIT_ORDER_ITEM, payload) as Promise<void>,
  deleteOrderItem: (orderItemId, reason, approval) =>
    ipcRenderer.invoke(
      IpcChannels.DELETE_ORDER_ITEM,
      orderItemId,
      reason,
      approval,
    ) as Promise<void>,
  cancelOrderWithReason: (orderId, reason, approval) =>
    ipcRenderer.invoke(
      IpcChannels.CANCEL_ORDER_WITH_REASON,
      orderId,
      reason,
      approval,
    ) as Promise<void>,
  cancelInvoiceWithReason: (invoiceNumber, reason, approval) =>
    ipcRenderer.invoke(
      IpcChannels.CANCEL_INVOICE_WITH_REASON,
      invoiceNumber,
      reason,
      approval,
    ) as Promise<void>,
  completeOrder: (orderId) =>
    ipcRenderer.invoke(IpcChannels.COMPLETE_ORDER, orderId) as Promise<void>,
  reprintOrder: (orderId) =>
    ipcRenderer.invoke(IpcChannels.REPRINT_ORDER, orderId) as Promise<void>,
  getMenuItems: () => ipcRenderer.invoke(IpcChannels.GET_MENU_ITEMS) as Promise<MenuCacheSnapshot>,
  refreshMenuCache: () =>
    ipcRenderer.invoke(IpcChannels.REFRESH_MENU_CACHE) as Promise<MenuCacheSnapshot>,
  setMenuItemActive: (menuItemId, isActive) =>
    ipcRenderer.invoke(
      IpcChannels.SET_MENU_ITEM_ACTIVE,
      menuItemId,
      isActive,
    ) as Promise<MenuCacheSnapshot>,
  listTables: () => ipcRenderer.invoke(IpcChannels.LIST_TABLES) as Promise<TableCard[]>,
  listManagedTables: () =>
    ipcRenderer.invoke(IpcChannels.LIST_MANAGED_TABLES) as Promise<ManagedTable[]>,
  listMenuCategories: () =>
    ipcRenderer.invoke(IpcChannels.LIST_MENU_CATEGORIES) as Promise<MenuCategory[]>,
  saveMenuItem: (payload) =>
    ipcRenderer.invoke(IpcChannels.SAVE_MENU_ITEM, payload) as Promise<MenuCacheSnapshot>,
  getMyAccess: () => ipcRenderer.invoke(IpcChannels.GET_MY_ACCESS) as Promise<MyAccess | null>,
  getTaxRate: () => ipcRenderer.invoke(IpcChannels.GET_TAX_RATE) as Promise<TaxRates>,
  listTaxRates: () => ipcRenderer.invoke(IpcChannels.LIST_TAX_RATES) as Promise<TaxRateRow[]>,
  addTaxRate: (payload: AddTaxRatePayload) =>
    ipcRenderer.invoke(IpcChannels.ADD_TAX_RATE, payload) as Promise<void>,
  deleteTaxRate: (id: string) => ipcRenderer.invoke(IpcChannels.DELETE_TAX_RATE, id) as Promise<void>,
  placeOrder: (payload) =>
    ipcRenderer.invoke(IpcChannels.PLACE_ORDER, payload) as Promise<PlaceOrderResult>,
  saveManagedTable: (payload) =>
    ipcRenderer.invoke(IpcChannels.SAVE_MANAGED_TABLE, payload) as Promise<void>,
  setManagedTableStatus: (tableId, status) =>
    ipcRenderer.invoke(IpcChannels.SET_MANAGED_TABLE_STATUS, tableId, status) as Promise<void>,
  deleteManagedTable: (tableId) =>
    ipcRenderer.invoke(IpcChannels.DELETE_MANAGED_TABLE, tableId) as Promise<void>,
  savePayment: (payload: SavePaymentPayload) =>
    ipcRenderer.invoke(IpcChannels.SAVE_ORDER_PAYMENT, payload) as Promise<void>,
  reprintTableBill: (orderId) =>
    ipcRenderer.invoke(IpcChannels.REPRINT_TABLE_BILL, orderId) as Promise<void>,
  testPrint: (target) => ipcRenderer.invoke(IpcChannels.TEST_PRINT, target) as Promise<string>,
  getSettings: () =>
    ipcRenderer.invoke(IpcChannels.GET_SETTINGS) as Promise<Record<string, string>>,
  updateSettings: (printerType, deviceName) =>
    ipcRenderer.invoke(IpcChannels.UPDATE_SETTINGS, printerType, deviceName) as Promise<void>,
  removePrinter: (printerType) =>
    ipcRenderer.invoke(IpcChannels.REMOVE_PRINTER, printerType) as Promise<void>,
  getMaxPrinters: () => ipcRenderer.invoke(IpcChannels.GET_MAX_PRINTERS) as Promise<number>,
  getInvoiceSequenceStatus: () =>
    ipcRenderer.invoke(
      IpcChannels.GET_INVOICE_SEQUENCE_STATUS,
    ) as Promise<InvoiceSequenceStatus | null>,
  resetInvoiceSequence: () =>
    ipcRenderer.invoke(IpcChannels.RESET_INVOICE_SEQUENCE) as Promise<void>,
  getServerStatus: () => ipcRenderer.invoke(IpcChannels.GET_SERVER_STATUS) as Promise<ServerStatus>,
  listApiDevices: () => ipcRenderer.invoke(IpcChannels.LIST_API_DEVICES) as Promise<ApiDevice[]>,
  createApiDevice: (name) =>
    ipcRenderer.invoke(IpcChannels.CREATE_API_DEVICE, name) as Promise<CreatedApiDevice>,
  revokeApiDevice: (id) => ipcRenderer.invoke(IpcChannels.REVOKE_API_DEVICE, id) as Promise<void>,
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  onOrderReceived: (cb) => on<OrderWithStatus>(IpcChannels.ORDER_RECEIVED, cb),
  onOrderStatusChanged: (cb) => on<OrderWithStatus>(IpcChannels.ORDER_STATUS_CHANGED, cb),
  onPrinterStatus: (cb) => on<PrinterInfo[]>(IpcChannels.PRINTER_STATUS, cb),
  onServerStatus: (cb) => on<ServerStatus>(IpcChannels.SERVER_STATUS, cb),
};

contextBridge.exposeInMainWorld('api', api);
