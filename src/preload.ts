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
  ServerStatus,
} from './shared/types';

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
  getSettings: () =>
    ipcRenderer.invoke(IpcChannels.GET_SETTINGS) as Promise<Record<string, string>>,
  updateSettings: (printerType, deviceName) =>
    ipcRenderer.invoke(IpcChannels.UPDATE_SETTINGS, printerType, deviceName) as Promise<void>,
  removePrinter: (printerType) =>
    ipcRenderer.invoke(IpcChannels.REMOVE_PRINTER, printerType) as Promise<void>,
  getMaxPrinters: () => ipcRenderer.invoke(IpcChannels.GET_MAX_PRINTERS) as Promise<number>,
  getServerStatus: () => ipcRenderer.invoke(IpcChannels.GET_SERVER_STATUS) as Promise<ServerStatus>,
  onOrderReceived: (cb) => on<OrderWithStatus>(IpcChannels.ORDER_RECEIVED, cb),
  onOrderStatusChanged: (cb) => on<OrderWithStatus>(IpcChannels.ORDER_STATUS_CHANGED, cb),
  onPrinterStatus: (cb) => on<PrinterInfo[]>(IpcChannels.PRINTER_STATUS, cb),
  onServerStatus: (cb) => on<ServerStatus>(IpcChannels.SERVER_STATUS, cb),
};

contextBridge.exposeInMainWorld('api', api);
