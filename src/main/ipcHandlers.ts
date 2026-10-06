import { ipcMain, BrowserWindow } from 'electron';
import { networkInterfaces } from 'os';
import { orderManager } from './orderManager';
import { getPrinters, testPrint } from './printerManager';
import { isServerRunning } from './api/httpServer';
import { db } from './data';
import { signIn, signOut, getCurrentUser } from './authManager';
import { listDevices, createDevice, revokeDevice } from './api/apiSecurity';

import { getAllPrinters, updatePrinter, removePrinter, getMaxPrinters } from './settingsManager';
import { exportSalesReport } from './reportExport';
import { 
  listUsers, 
  listOutlets, 
  createUser, 
  updateUser, 
  setUserActive,
  listGroups,
  listPermissions,
  listGroupMemberships,
  saveGroup,
  deleteGroup,
  setGroupMembers,
  setUserGroups,
  getUserAccess, 
} from './userAdmin';
import { listMenuCategories, saveMenuItem } from './menuManager';
import { getMyAccess } from './accessManager';
import { getTaxRate, placeOrder } from './orderEntryManager';
import {
  listOrders,
    getInvoiceOrderDetail,
    getInvoiceActivityLog,
    editOrderItem,
    deleteOrderItem,
    cancelOrderWithReason,
    cancelInvoiceWithReason,
    completeOrder,
    reprintOrder,
    reprintTableBill,
} from './ordersListManager';
import { getCachedMenuItems, refreshMenuCache, setMenuItemActive } from './menuCache';
import { 
  listTables, 
  listManagedTables,
  saveManagedTable,
  deleteManagedTable,
  setManagedTableStatus,
} from './tablesManager';
import { config } from './config';

import { IpcChannels } from '../shared/types';
import type {
  ServerStatus,
  SalesReportExportPayload,
  CreateUserPayload,
  SaveGroupPayload,
  UpdateUserPayload,
  OrderListFilter,
  EditOrderItemPayload,
  EditorApproval,
  ReportBucket,
  SavePaymentPayload,
  SaveManagedTablePayload,
  PlaceOrderPayload,
  SaveMenuItemPayload,
  ManagedTableStatus,
} from '../shared/types';

/**
 * This machine's LAN IPv4 address — what Android should actually point the
 * printer at, as opposed to config.http.host (the bind address, typically
 * 0.0.0.0 or localhost and not reachable from another device). Picks the
 * first non-internal IPv4 interface; on a machine with several active
 * network adapters (e.g. Wi-Fi + Ethernet both up) this is a best guess, not
 * a guarantee of the "right" one — Settings can surface all of them if that
 * turns out to matter in practice.
 */
function getLocalIpAddress(): string | null {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

// Pairing a phone grants it access to orders and the menu, so only a user who may
// manage users can do it. Checked here, in the main process, not just hidden in the UI.
async function requireDeviceAdmin(): Promise<void> {
  const access = await getMyAccess();
  if (!access?.permissions.includes('users.manage')) {
    throw new Error('Only an administrator can manage paired devices.');
  }
}

async function buildServerStatus(): Promise<ServerStatus> {
  return {
    running: isServerRunning(),
    port: config.http.port,
    host: config.http.host,
    database: (await db.orders.isReachable()) ? 'connected' : 'disconnected',
    ipAddress: getLocalIpAddress(),
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
  ipcMain.handle(IpcChannels.TEST_PRINT, (_e, target?: string) => testPrint(target));

  // Printers & Settings (multi-printer support)
  ipcMain.handle(IpcChannels.GET_SETTINGS, () => getAllPrinters());
  ipcMain.handle(IpcChannels.UPDATE_SETTINGS, (_e, printerType: string, deviceName: string) =>
    updatePrinter(printerType, deviceName),
  );
  ipcMain.handle(IpcChannels.REMOVE_PRINTER, (_e, printerType: string) =>
    removePrinter(printerType),
  );
  ipcMain.handle(IpcChannels.GET_MAX_PRINTERS, () => getMaxPrinters());

  // Invoicing (admin-only — enforced server-side by the RPCs)
  // ipcMain.handle(IpcChannels.GET_INVOICE_SEQUENCE_STATUS, () => getInvoiceSequenceStatus());
  // ipcMain.handle(IpcChannels.RESET_INVOICE_SEQUENCE, () => resetInvoiceSequence());

  ipcMain.handle(IpcChannels.GET_SERVER_STATUS, () => buildServerStatus());
  ipcMain.handle(IpcChannels.LIST_API_DEVICES, async () => {
    await requireDeviceAdmin();
    return listDevices();
  });
  ipcMain.handle(IpcChannels.CREATE_API_DEVICE, async (_e, name: string) => {
    await requireDeviceAdmin();
    return createDevice(name);
  });
  ipcMain.handle(IpcChannels.REVOKE_API_DEVICE, async (_e, id: string) => {
    await requireDeviceAdmin();
    revokeDevice(id);
  });

  // Sales report (manager/owner/admin — enforced server-side by the RPC)
  ipcMain.handle(
    IpcChannels.GET_SALES_REPORT,
    (_e, from: string, to: string, bucket: 'day' | 'month') => 
    db.reports.salesReport(from, to, bucket),
  );
  ipcMain.handle(IpcChannels.GET_TOP_ITEMS, (_e, from: string, to: string) =>
    db.reports.topItems(from, to, 10),
  );
    ipcMain.handle(IpcChannels.GET_SALES_BY_ORDER_TYPE, (_e, from: string, to: string) =>
    db.reports.salesByOrderType(from, to),
    );
    ipcMain.handle(
      IpcChannels.GET_SALES_BY_TYPE_BUCKETED,
      (_e, from: string, to: string, bucket: ReportBucket) =>
      db.reports.salesByTypeBucketed(from, to, bucket),
    );
  ipcMain.handle(IpcChannels.EXPORT_SALES_REPORT, (_e, payload: SalesReportExportPayload) =>
    exportSalesReport(getWindow(), payload),
  );

  // User management (admin-only — enforced server-side by the RPCs / assertCallerIsAdmin)
  ipcMain.handle(IpcChannels.LIST_USERS, () => listUsers());
  ipcMain.handle(IpcChannels.LIST_OUTLETS, () => listOutlets());
  ipcMain.handle(IpcChannels.CREATE_USER, (_e, payload: CreateUserPayload) => createUser(payload));
  ipcMain.handle(IpcChannels.UPDATE_USER, (_e, payload: UpdateUserPayload) => updateUser(payload));
  ipcMain.handle(IpcChannels.SET_USER_ACTIVE, (_e, userId: string, isActive: boolean) =>
    setUserActive(userId, isActive),
  );

  // User groups (admin-only — enforced server-side by the RPCs)
  ipcMain.handle(IpcChannels.LIST_GROUPS, () => listGroups());
  ipcMain.handle(IpcChannels.LIST_PERMISSIONS, () => listPermissions());
  ipcMain.handle(IpcChannels.LIST_GROUP_MEMBERSHIPS, () => listGroupMemberships());
  ipcMain.handle(IpcChannels.SAVE_GROUP, (_e, payload: SaveGroupPayload) => saveGroup(payload));
  ipcMain.handle(IpcChannels.DELETE_GROUP, (_e, groupId: string) => deleteGroup(groupId));
  ipcMain.handle(IpcChannels.SET_GROUP_MEMBERS, (_e, groupId: string, userIds: string[]) =>
    setGroupMembers(groupId, userIds),
  );
  ipcMain.handle(IpcChannels.SET_USER_GROUPS, (_e, userId: string, groupIds: string[]) =>
    setUserGroups(userId, groupIds),
  );
  ipcMain.handle(IpcChannels.GET_USER_ACCESS, (_e, userId: string) => getUserAccess(userId));

  // Orders List (manager/owner/admin — enforced server-side by the RPCs)
  ipcMain.handle(IpcChannels.LIST_ORDERS, (_e, filter: OrderListFilter) => listOrders(filter));
  ipcMain.handle(IpcChannels.GET_INVOICE_ORDER_DETAIL, (_e, invoiceNumber: string) =>
    getInvoiceOrderDetail(invoiceNumber),
  );
  ipcMain.handle(IpcChannels.GET_INVOICE_ACTIVITY_LOG, (_e, invoiceNumber: string) =>
    getInvoiceActivityLog(invoiceNumber),
  );
  ipcMain.handle(IpcChannels.EDIT_ORDER_ITEM, (_e, payload: EditOrderItemPayload) =>
    editOrderItem(payload),
  );
  ipcMain.handle(
    IpcChannels.DELETE_ORDER_ITEM,
    (_e, orderItemId: string, reason: string, approval: EditorApproval) =>
      deleteOrderItem(orderItemId, reason, approval),
  );
  ipcMain.handle(
    IpcChannels.CANCEL_ORDER_WITH_REASON,
    (_e, orderId: string, reason: string, approval: EditorApproval) =>
      cancelOrderWithReason(orderId, reason, approval),
  );
  ipcMain.handle(
    IpcChannels.CANCEL_INVOICE_WITH_REASON,
    (_e, invoiceNumber: string, reason: string, approval: EditorApproval) =>
      cancelInvoiceWithReason(invoiceNumber, reason, approval),
  );
  ipcMain.handle(IpcChannels.COMPLETE_ORDER, (_e, orderId: string) => completeOrder(orderId));
  ipcMain.handle(IpcChannels.REPRINT_ORDER, (_e, orderId: string) => reprintOrder(orderId));

  // Menu cache: getCachedMenuItems() is synchronous (no DB call) — wrapped
    // in Promise.resolve() only so it matches the async invoke() contract.
    ipcMain.handle(IpcChannels.GET_MENU_ITEMS, () => Promise.resolve(getCachedMenuItems()));
    ipcMain.handle(IpcChannels.REFRESH_MENU_CACHE, () => refreshMenuCache());
  ipcMain.handle(
    IpcChannels.SET_MENU_ITEM_ACTIVE,
    (_e, menuItemId: string, isActive: boolean) => setMenuItemActive(menuItemId, isActive),
  );

  // Dashboard table cards
  ipcMain.handle(IpcChannels.LIST_TABLES, () => listTables());
  ipcMain.handle(IpcChannels.LIST_MANAGED_TABLES, () => listManagedTables());
  ipcMain.handle(IpcChannels.LIST_MENU_CATEGORIES, () => listMenuCategories());
  ipcMain.handle(IpcChannels.SAVE_MENU_ITEM, (_e, payload: SaveMenuItemPayload) => saveMenuItem(payload));
  ipcMain.handle(IpcChannels.GET_MY_ACCESS, () => getMyAccess());
  ipcMain.handle(IpcChannels.GET_TAX_RATE, () => getTaxRate());
  ipcMain.handle(IpcChannels.PLACE_ORDER, (_e, payload: PlaceOrderPayload) => placeOrder(payload));
  ipcMain.handle(IpcChannels.SAVE_MANAGED_TABLE, (_e, payload: SaveManagedTablePayload) =>
    saveManagedTable(payload),
  );
  ipcMain.handle(
    IpcChannels.SET_MANAGED_TABLE_STATUS,
    (_e, tableId: string, status: ManagedTableStatus) => setManagedTableStatus(tableId, status),
  );
  ipcMain.handle(IpcChannels.DELETE_MANAGED_TABLE, (_e, tableId: string) =>
    deleteManagedTable(tableId),
  );
  // ipcMain.handle(IpcChannels.SAVE_ORDER_PAYMENT, (_e, payload: SavePaymentPayload) =>
  //   savePayment(payload),
  // );
  ipcMain.handle(IpcChannels.REPRINT_TABLE_BILL, (_e, orderId: string) => reprintTableBill(orderId));

  // main -> renderer (forward manager events to the active window)
  const send = (channel: string, payload: unknown) => {
    getWindow()?.webContents.send(channel, payload);
  };

  orderManager.on('order-received', (order) => send(IpcChannels.ORDER_RECEIVED, order));
  orderManager.on('status-changed', (order) => send(IpcChannels.ORDER_STATUS_CHANGED, order));
}
