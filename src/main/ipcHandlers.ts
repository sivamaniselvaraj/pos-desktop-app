import { ipcMain, BrowserWindow } from 'electron';
import { orderManager } from './orderManager';
import { getPrinters } from './printerManager';
import { isServerRunning } from './httpServer';
import { isDatabaseReachable, fetchSalesReport, fetchTopItems } from './supabaseClient';
import { signIn, signOut, getCurrentUser } from './authManager';
import {
  getAllPrinters,
  updatePrinter,
  removePrinter,
  getMaxPrinters,
} from './settingsManager';
import { exportSalesReport } from './reportExport';
import { config } from './config';
import { IpcChannels } from '../shared/types';
import type { ServerStatus, SalesReportExportPayload } from '../shared/types';

async function buildServerStatus(): Promise<ServerStatus> {
  return {
    running: isServerRunning(),
    port: config.http.port,
    host: config.http.host,
    database: (await isDatabaseReachable()) ? 'connected' : 'disconnected',
  };
}

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  // auth (renderer -> main)
  ipcMain.handle(IpcChannels.AUTH_SIGN_IN, (_e, email: string, password: string) =>
    signIn(email, password),
  );
  ipcMain.handle(IpcChannels.AUTH_SIGN_OUT, () => signOut());
  ipcMain.handle(IpcChannels.AUTH_GET_SESSION, () => getCurrentUser());

  // orders renderer -> main (invoke/handle)
  ipcMain.handle(IpcChannels.GET_ORDERS, () => orderManager.getAll());
  ipcMain.handle(IpcChannels.RETRY_PRINT, (_e, orderId: string) => orderManager.retry(orderId));
  ipcMain.handle(IpcChannels.CANCEL_ORDER, (_e, orderId: string) => orderManager.cancel(orderId));
  ipcMain.handle(IpcChannels.CLEAR_PRINTED, () => orderManager.clearPrinted());
  ipcMain.handle(IpcChannels.GET_PRINTERS, () => getPrinters());

    // Printers & Settings (multi-printer support)
  ipcMain.handle(IpcChannels.GET_SETTINGS, () => getAllPrinters());
  ipcMain.handle(IpcChannels.UPDATE_SETTINGS, (_e, printerType: string, deviceName: string) =>
    updatePrinter(printerType, deviceName),
  );
  ipcMain.handle(IpcChannels.REMOVE_PRINTER, (_e, printerType: string) =>
    removePrinter(printerType),
  );
  ipcMain.handle(IpcChannels.GET_MAX_PRINTERS, () => getMaxPrinters());

  ipcMain.handle(IpcChannels.GET_SERVER_STATUS, () => buildServerStatus());

    // Sales report (manager/owner/admin — enforced server-side by the RPC)
    ipcMain.handle(IpcChannels.GET_SALES_REPORT, (_e, from: string, to: string, bucket: 'day' | 'month') =>
      fetchSalesReport(from, to, bucket),
    );
    ipcMain.handle(IpcChannels.GET_TOP_ITEMS, (_e, from: string, to: string) =>
      fetchTopItems(from, to),
    );
  ipcMain.handle(IpcChannels.EXPORT_SALES_REPORT, (_e, payload: SalesReportExportPayload) =>
    exportSalesReport(getWindow(), payload),
  );

  // main -> renderer (forward manager events to the active window)
  const send = (channel: string, payload: unknown) => {
    getWindow()?.webContents.send(channel, payload);
  };

  orderManager.on('order-received', (order) => send(IpcChannels.ORDER_RECEIVED, order));
  orderManager.on('status-changed', (order) => send(IpcChannels.ORDER_STATUS_CHANGED, order));
}
