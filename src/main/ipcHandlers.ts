import { ipcMain, BrowserWindow } from 'electron';
import { orderManager } from './orderManager';
import { getPrinters } from './printerManager';
import { isServerRunning } from './httpServer';
import { isDatabaseReachable } from './supabaseClient';
import { signIn, signOut, getCurrentUser } from './authManager';
import { config } from './config';
import { IpcChannels } from '../shared/types';
import type { ServerStatus } from '../shared/types';

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

  // renderer -> main (invoke/handle)
  ipcMain.handle(IpcChannels.GET_ORDERS, () => orderManager.getAll());
  ipcMain.handle(IpcChannels.RETRY_PRINT, (_e, orderId: string) => orderManager.retry(orderId));
  ipcMain.handle(IpcChannels.CANCEL_ORDER, (_e, orderId: string) => orderManager.cancel(orderId));
  ipcMain.handle(IpcChannels.CLEAR_PRINTED, () => orderManager.clearPrinted());
  ipcMain.handle(IpcChannels.GET_PRINTERS, () => getPrinters());
  ipcMain.handle(IpcChannels.GET_SERVER_STATUS, () => buildServerStatus());

  // main -> renderer (forward manager events to the active window)
  const send = (channel: string, payload: unknown) => {
    getWindow()?.webContents.send(channel, payload);
  };

  orderManager.on('order-received', (order) => send(IpcChannels.ORDER_RECEIVED, order));
  orderManager.on('status-changed', (order) => send(IpcChannels.ORDER_STATUS_CHANGED, order));
}
