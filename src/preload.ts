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
  OutletOption,
  OrderListPage,
  OrderDetailItem,
  OrderActivityLogEntry,
  MenuCacheSnapshot,
  TableCard,
  ServerStatus,  
  SavePaymentPayload,
  TableOrderDetail,
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
  listOrders: (filter) =>
      ipcRenderer.invoke(IpcChannels.LIST_ORDERS, filter) as Promise<OrderListPage>,
    getOrderDetail: (orderId) =>
      ipcRenderer.invoke(IpcChannels.GET_ORDER_DETAIL, orderId) as Promise<OrderDetailItem[]>,
  getTableOrderDetail: (orderId) =>
    ipcRenderer.invoke(IpcChannels.GET_TABLE_ORDER_DETAIL, orderId) as Promise<TableOrderDetail>,
  getTableActivityLog: (orderId) =>
    ipcRenderer.invoke(IpcChannels.GET_TABLE_ACTIVITY_LOG, orderId) as Promise<
      OrderActivityLogEntry[]
    >,
    editOrderItem: (payload) =>
      ipcRenderer.invoke(IpcChannels.EDIT_ORDER_ITEM, payload) as Promise<void>,
    deleteOrderItem: (orderItemId, reason) =>
      ipcRenderer.invoke(IpcChannels.DELETE_ORDER_ITEM, orderItemId, reason) as Promise<void>,
    cancelOrderWithReason: (orderId, reason) =>
      ipcRenderer.invoke(IpcChannels.CANCEL_ORDER_WITH_REASON, orderId, reason) as Promise<void>,
    completeOrder: (orderId) =>
      ipcRenderer.invoke(IpcChannels.COMPLETE_ORDER, orderId) as Promise<void>,
    reprintOrder: (orderId) =>
      ipcRenderer.invoke(IpcChannels.REPRINT_ORDER, orderId) as Promise<void>,
    getOrderActivityLog: (orderId) =>
      ipcRenderer.invoke(IpcChannels.GET_ORDER_ACTIVITY_LOG, orderId) as Promise<
        OrderActivityLogEntry[]
      >,
      getMenuItems: () =>
          ipcRenderer.invoke(IpcChannels.GET_MENU_ITEMS) as Promise<MenuCacheSnapshot>,
        refreshMenuCache: () =>
          ipcRenderer.invoke(IpcChannels.REFRESH_MENU_CACHE) as Promise<MenuCacheSnapshot>,
  setMenuItemActive: (menuItemId, isActive) =>
    ipcRenderer.invoke(IpcChannels.SET_MENU_ITEM_ACTIVE, menuItemId, isActive) as Promise<
      MenuCacheSnapshot
    >,
  listTables: () => ipcRenderer.invoke(IpcChannels.LIST_TABLES) as Promise<TableCard[]>,
  createTable: (tableNumber) =>
    ipcRenderer.invoke(IpcChannels.CREATE_TABLE, tableNumber) as Promise<void>,
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
  getServerStatus: () => 
    ipcRenderer.invoke(IpcChannels.GET_SERVER_STATUS) as Promise<ServerStatus>,
  onOrderReceived: (cb) => on<OrderWithStatus>(IpcChannels.ORDER_RECEIVED, cb),
  onOrderStatusChanged: (cb) => on<OrderWithStatus>(IpcChannels.ORDER_STATUS_CHANGED, cb),
  onPrinterStatus: (cb) => on<PrinterInfo[]>(IpcChannels.PRINTER_STATUS, cb),
  onServerStatus: (cb) => on<ServerStatus>(IpcChannels.SERVER_STATUS, cb),
};

contextBridge.exposeInMainWorld('api', api);
