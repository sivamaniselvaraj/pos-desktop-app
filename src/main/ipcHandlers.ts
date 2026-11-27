import { ipcMain, BrowserWindow } from 'electron';
import { networkInterfaces } from 'os';
import { orderManager } from './orderManager';
import { getPrinters, testPrint } from './printerManager';
import { isServerRunning } from './api/httpServer';
import { db } from './data';
import { signIn, signOut, getCurrentUser } from './authManager';
import { getOfflineStatus, isDatabaseConnected } from './offlineManager';
import { clearAlerts, dismissKotProblem, getAlertSnapshot, markAlertsRead, saveAlertSettings } from './desktopAlerts';
import type { AlertSettings } from '../shared/alertTypes';
import { getConnectionStatus } from './connectionSetup';
import { saveConnectionSetup } from './setupManager';
import { listDevices, revokeDevice, resetDevicePin } from './api/apiSecurity';
import { cancelCode, createCode } from './api/pairingCodes';

import { getAllPrinters, updatePrinter, removePrinter, getMaxPrinters } from './settingsManager';
import { getInvoiceSequenceStatus, resetInvoiceSequence } from './invoiceManager';
import { exportSalesReport } from './reportExport';
import { exportCurrentMenu, exportMenuTemplate } from './menuExport';
import { commitMenuUpload, listMenuUploadLog, pickMenuUploadFile, saveUploadErrorRows } from './menuImport';
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
} from './userManager';
import { getMenuItem, listMenuCategories, listMenuCategoriesAdmin, reorderMenuCategories, saveMenuCategory, saveMenuItem, setMenuCategoryActive } from './menuManager';
import { getMyAccess,getReceiptText, saveBrandColor, saveReceiptText } from './accessManager';
import { getTaxRate, placeOrder } from './orderEntryManager';
import { getKotBoard, getKotWorkflow, getUnprintedKots, moveKot, moveKotItems, printKotNow, saveKotWorkflow } from './kotManager';
import { addTaxRate, deleteTaxRate, listTaxRates } from './taxManager';
import {
  checkForUpdates,
  getInstallCheck,
  getUpdateStatus,
  installUpdate,
  setUpdateChannel,
} from './updateManager.js';
import {
  listOrders,
  listActiveTakeaway,
  getInvoiceOrderDetail,
  getInvoiceActivityLog,
  editOrderItem,
  deleteOrderItem,
  cancelOrderWithReason,
  setOrderDiscount,
  getDiscountOptions,
  getDiscountSettings,
  saveDiscountPresets,
  cancelInvoiceWithReason,
  completeOrder,
  completeInvoice,
  reprintOrder,
} from './ordersListManager';
import { 
  getCachedMenuItems, 
  refreshMenuCache, 
  setCategoryActive, 
  setMenuItemActive, 
  setMenuItemsActive 
} from './menuCache';
import {
  listTables,
  savePayment,
  listManagedTables,
  saveManagedTable,
  setManagedTableActive,
  setManagedTableStatus,
} from './tablesManager';
import { config, normalizePrintMethod } from './config';
import { setPrinterAddress } from './imagePrintHelper';
import { IpcChannels } from '../shared/ipc';
import { restartLiveWatch } from './liveUpdatesManager';
import type {
  ReceiptText,
  ServerStatus,
  CreateUserPayload,
  SaveGroupPayload,
  UpdateUserPayload,
  OrderListFilter,
  EditOrderItemPayload,
  EditorApproval,
  SetOrderDiscountPayload,
  DiscountPreset,
  SavePaymentPayload,
  SaveManagedTablePayload,
  PlaceOrderPayload,
  SaveMenuItemPayload,
  ManagedTableStatus,
  AddTaxRatePayload,
  KotWorkflow,
} from '../shared/types';
import type { ConnectionSetupInput } from '../shared/connectionTypes';
import type { SalesReportExportPayload, ReportBucket, ShiftWindow } from '../shared/reportTypes';
import { registerTimingHandlers, timedHandle } from './ipcTimingManager.js';

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
    // The 5 s health check's answer (offlineManager), not a new database call.
    database: (await isDatabaseConnected()) ? 'connected' : 'disconnected',
    ipAddress: getLocalIpAddress(),
  };
}

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  // Speed measurements: every handler below is timed by timedHandle (docs/TIMINGS.md).
  registerTimingHandlers();

  // auth (renderer -> main)
  timedHandle(IpcChannels.AUTH_SIGN_IN, async (_e, email: string, password: string) => {
    const result = await signIn(email, password);
    restartLiveWatch(); // the change check needs the new session (docs/LIVE_UPDATES.md)
    return result;
  });
  timedHandle(IpcChannels.AUTH_SIGN_OUT, () => signOut());
  timedHandle(IpcChannels.AUTH_GET_SESSION, () => getCurrentUser());

  // connection setup (setup screen)
  timedHandle(IpcChannels.SETUP_GET_STATUS, () => getConnectionStatus());
  timedHandle(IpcChannels.SETUP_SAVE, (_e, input: ConnectionSetupInput) =>
    saveConnectionSetup(input ?? { databaseUrl: '', outletId: '' }),
  );

  // orders (renderer -> main, invoke/handle)
  timedHandle(IpcChannels.GET_ORDERS, () => orderManager.getAll());
  timedHandle(IpcChannels.RETRY_PRINT, (_e, orderId: string) => orderManager.retry(orderId));
  timedHandle(IpcChannels.CANCEL_ORDER, (_e, orderId: string) => orderManager.cancel(orderId));
  timedHandle(IpcChannels.CLEAR_PRINTED, () => orderManager.clearPrinted());
  timedHandle(IpcChannels.GET_PRINTERS, (_e, refresh?: boolean) => getPrinters(refresh === true));
  timedHandle(IpcChannels.GET_PRINT_METHOD, () => config.printMethod);
  timedHandle(IpcChannels.SET_PRINT_METHOD, (_e, method: unknown) => {
    config.printMethod = normalizePrintMethod(method);
  });
  timedHandle(IpcChannels.GET_PRINTER_ADDRESSES, () => config.printerAddresses);
  timedHandle(IpcChannels.SET_PRINTER_ADDRESS, (_e, printerName: unknown, address: unknown) =>
    setPrinterAddress(String(printerName ?? ''), String(address ?? '')),
  );
  timedHandle(IpcChannels.TEST_PRINT, (_e, target?: string) => testPrint(target));

  // Printers & Settings (multi-printer support)
  timedHandle(IpcChannels.GET_SETTINGS, () => getAllPrinters());
  timedHandle(IpcChannels.UPDATE_SETTINGS, (_e, printerType: string, deviceName: string) =>
    updatePrinter(printerType, deviceName),
  );
  timedHandle(IpcChannels.REMOVE_PRINTER, (_e, printerType: string) =>
    removePrinter(printerType),
  );
  timedHandle(IpcChannels.GET_MAX_PRINTERS, () => getMaxPrinters());

  // Invoicing (admin-only — enforced server-side by the RPCs)
  timedHandle(IpcChannels.GET_INVOICE_SEQUENCE_STATUS, () => getInvoiceSequenceStatus());
  timedHandle(IpcChannels.RESET_INVOICE_SEQUENCE, () => resetInvoiceSequence());

  timedHandle(IpcChannels.GET_SERVER_STATUS, () => buildServerStatus());
  timedHandle(IpcChannels.GET_OFFLINE_STATUS, () => getOfflineStatus());
  timedHandle(IpcChannels.LIST_API_DEVICES, async () => {
    await requireDeviceAdmin();
    return listDevices();
  });
  timedHandle(IpcChannels.CREATE_PAIRING_CODE, async () => {
    await requireDeviceAdmin();
    return createCode();
  });
  timedHandle(IpcChannels.CANCEL_PAIRING_CODE, async () => {
    await requireDeviceAdmin();
    cancelCode();
  });
  timedHandle(IpcChannels.REVOKE_API_DEVICE, async (_e, id: string) => {
    await requireDeviceAdmin();
    revokeDevice(id);
  });
  timedHandle(IpcChannels.RESET_API_DEVICE_PIN, async (_e, id: string) => {
    await requireDeviceAdmin();
    resetDevicePin(id);
  });

  // Reports: every report function takes the outlet. It is this PC's outlet (OUTLET_ID in the
  // connection settings, else the signed-in user's own outlet); the database checks the caller may
  // see it (docs/SALES_REPORTS.md, "Outlet parameter").


  timedHandle(IpcChannels.GET_MENU_AVAILABILITY, (_e, outlet: string, from: string, to: string) => db.reports.menuAvailability(outlet, from, to));
  timedHandle(IpcChannels.GET_VOIDS_DISCOUNTS, (_e, outlet: string, from: string, to: string) => db.reports.voidsDiscounts(outlet, from, to));
  timedHandle(IpcChannels.GET_SALES_BY_WAITER, (_e, outlet: string, from: string, to: string) => db.reports.salesByWaiter(outlet, from, to));

  // Sales report (manager/owner/admin — enforced server-side by the RPC)
  timedHandle(
    IpcChannels.GET_SALES_REPORT,
    (_e, outlet: string, from: string, to: string, bucket: 'day' | 'month') =>
    db.reports.salesReport(outlet, from, to, bucket),
  );
  timedHandle(IpcChannels.GET_TOP_ITEMS, (_e, outlet: string, from: string, to: string) =>
    db.reports.topItems(outlet, from, to, 10),
  );
  timedHandle(IpcChannels.GET_SALES_BY_ORDER_TYPE, (_e, outlet: string, from: string, to: string) =>
    db.reports.salesByOrderType(outlet, from, to),
  );
  timedHandle(
    IpcChannels.GET_SALES_BY_TYPE_BUCKETED,
    (_e, outlet: string, from: string, to: string, bucket: ReportBucket) =>
      db.reports.salesByTypeBucketed(outlet, from, to, bucket),
  );
  timedHandle(IpcChannels.EXPORT_SALES_REPORT, (_e, payload: SalesReportExportPayload) =>
    exportSalesReport(getWindow(), payload),
  );
  // Settings > Menu upload (menu.upload is checked by the database function; docs/MENU_UPLOAD.md)
  timedHandle(IpcChannels.PICK_MENU_UPLOAD_FILE, () => pickMenuUploadFile(getWindow()));
  timedHandle(IpcChannels.COMMIT_MENU_UPLOAD, (_e, token: string) => commitMenuUpload(token));
  timedHandle(IpcChannels.SAVE_MENU_UPLOAD_ERRORS, (_e, token: string) => saveUploadErrorRows(getWindow(), token));
  timedHandle(IpcChannels.GET_MENU_UPLOAD_LOG, () => listMenuUploadLog());
  timedHandle(IpcChannels.DOWNLOAD_MENU_TEMPLATE, () => exportMenuTemplate(getWindow()));
  timedHandle(IpcChannels.DOWNLOAD_CURRENT_MENU, () => exportCurrentMenu(getWindow()));
  // Sales and revenue reports (reports.view, checked by each RPC; docs/SALES_REPORTS.md)
  timedHandle(IpcChannels.GET_DAILY_SUMMARY, (_e, outlet: string, from: string, to: string, shift: ShiftWindow | null) =>
    db.reports.dailySummary(outlet, from, to, shift ?? null),
  );
  timedHandle(IpcChannels.GET_SALES_BY_HOUR, (_e, outlet: string, from: string, to: string) => db.reports.salesByHour(outlet, from, to));
  timedHandle(IpcChannels.GET_PRODUCT_MIX, (_e, outlet: string, from: string, to: string) => db.reports.productMix(outlet, from, to));
  timedHandle(IpcChannels.GET_SALES_BY_CHANNEL, (_e, outlet: string, from: string, to: string) => db.reports.salesByChannel(outlet, from, to));

  // User management (admin-only — enforced server-side by the RPCs / assertCallerIsAdmin)
  timedHandle(IpcChannels.LIST_USERS, () => listUsers());
  timedHandle(IpcChannels.LIST_OUTLETS, () => listOutlets());
  timedHandle(IpcChannels.CREATE_USER, (_e, payload: CreateUserPayload) => createUser(payload));
  timedHandle(IpcChannels.UPDATE_USER, (_e, payload: UpdateUserPayload) => updateUser(payload));
  timedHandle(IpcChannels.SET_USER_ACTIVE, (_e, userId: string, isActive: boolean) =>
    setUserActive(userId, isActive),
  );

  // User groups (admin-only — enforced server-side by the RPCs)
  timedHandle(IpcChannels.LIST_GROUPS, () => listGroups());
  timedHandle(IpcChannels.LIST_PERMISSIONS, () => listPermissions());
  timedHandle(IpcChannels.LIST_GROUP_MEMBERSHIPS, () => listGroupMemberships());
  timedHandle(IpcChannels.SAVE_GROUP, (_e, payload: SaveGroupPayload) => saveGroup(payload));
  timedHandle(IpcChannels.DELETE_GROUP, (_e, groupId: string) => deleteGroup(groupId));
  timedHandle(IpcChannels.SET_GROUP_MEMBERS, (_e, groupId: string, userIds: string[]) =>
    setGroupMembers(groupId, userIds),
  );
  timedHandle(IpcChannels.SET_USER_GROUPS, (_e, userId: string, groupIds: string[]) =>
    setUserGroups(userId, groupIds),
  );
  timedHandle(IpcChannels.GET_USER_ACCESS, (_e, userId: string) => getUserAccess(userId));

  // Orders List (manager/owner/admin — enforced server-side by the RPCs)
  timedHandle(IpcChannels.LIST_ACTIVE_TAKEAWAY, () => listActiveTakeaway());
  timedHandle(IpcChannels.LIST_ORDERS, (_e, filter: OrderListFilter) => listOrders(filter));
  timedHandle(IpcChannels.GET_INVOICE_ORDER_DETAIL, (_e, invoiceNumber: string) =>
    getInvoiceOrderDetail(invoiceNumber),
  );
  timedHandle(IpcChannels.GET_INVOICE_ACTIVITY_LOG, (_e, invoiceNumber: string) =>
    getInvoiceActivityLog(invoiceNumber),
  );
  timedHandle(IpcChannels.EDIT_ORDER_ITEM, (_e, payload: EditOrderItemPayload) =>
    editOrderItem(payload),
  );
  timedHandle(
    IpcChannels.DELETE_ORDER_ITEM,
    (_e, orderItemId: string, reason: string, approval: EditorApproval) =>
      deleteOrderItem(orderItemId, reason, approval),
  );
  timedHandle(IpcChannels.GET_DISCOUNT_SETTINGS, () => getDiscountSettings());
  timedHandle(IpcChannels.SAVE_DISCOUNT_PRESETS, (_e, presets: DiscountPreset[]) => saveDiscountPresets(presets));
  timedHandle(IpcChannels.GET_DISCOUNT_OPTIONS, () => getDiscountOptions());
  timedHandle(IpcChannels.SET_ORDER_DISCOUNT, (_e, payload: SetOrderDiscountPayload) => setOrderDiscount(payload));
  timedHandle(
    IpcChannels.CANCEL_ORDER_WITH_REASON,
    (_e, orderId: string, reason: string, approval: EditorApproval) =>
      cancelOrderWithReason(orderId, reason, approval),
  );
  timedHandle(
    IpcChannels.CANCEL_INVOICE_WITH_REASON,
    (_e, invoiceNumber: string, reason: string, approval: EditorApproval) =>
      cancelInvoiceWithReason(invoiceNumber, reason, approval),
  );
  timedHandle(IpcChannels.COMPLETE_ORDER, (_e, orderId: string) => completeOrder(orderId));
  timedHandle(IpcChannels.COMPLETE_INVOICE, (_e, invoiceNumber: string) => completeInvoice(invoiceNumber));
  timedHandle(IpcChannels.REPRINT_ORDER, (_e, invoiceNumber: string) => reprintOrder(invoiceNumber));

  // Menu cache: getCachedMenuItems() is synchronous (no DB call) — wrapped
  // in Promise.resolve() only so it matches the async invoke() contract.
  timedHandle(IpcChannels.GET_MENU_ITEMS, () => Promise.resolve(getCachedMenuItems()));
  timedHandle(IpcChannels.REFRESH_MENU_CACHE, () => refreshMenuCache());
  timedHandle(IpcChannels.SET_MENU_ITEMS_ACTIVE, (_e, ids: string[], isActive: boolean, reason?: string) =>
    setMenuItemsActive(ids, isActive, reason),
  );
  timedHandle(IpcChannels.SET_CATEGORY_ACTIVE, (_e, categoryId: string, isActive: boolean, reason?: string) =>
    setCategoryActive(categoryId, isActive, reason),
  );
  timedHandle(
    IpcChannels.SET_MENU_ITEM_ACTIVE,
    (_e, menuItemId: string, isActive: boolean, reason?: string) => setMenuItemActive(menuItemId, isActive, reason),
  );

  // Dashboard table cards
  timedHandle(IpcChannels.LIST_TABLES, () => listTables());
  timedHandle(IpcChannels.LIST_MANAGED_TABLES, () => listManagedTables());
  timedHandle(IpcChannels.LIST_MENU_CATEGORIES, () => listMenuCategories());
  timedHandle(IpcChannels.LIST_MENU_CATEGORIES_ADMIN, () => listMenuCategoriesAdmin());
  timedHandle(IpcChannels.SAVE_MENU_CATEGORY, (_e, payload: { id?: string; name: string }) => saveMenuCategory(payload));
  timedHandle(IpcChannels.REORDER_MENU_CATEGORIES, (_e, ids: string[]) => reorderMenuCategories(ids));
  timedHandle(IpcChannels.SET_MENU_CATEGORY_ACTIVE, (_e, id: string, isActive: boolean) => setMenuCategoryActive(id, isActive));
  timedHandle(IpcChannels.GET_MENU_ITEM, (_e, id: string) => getMenuItem(id));
  timedHandle(IpcChannels.SAVE_MENU_ITEM, (_e, payload: SaveMenuItemPayload) => saveMenuItem(payload));
  timedHandle(IpcChannels.GET_RECEIPT_TEXT, () => getReceiptText());
  timedHandle(IpcChannels.SAVE_RECEIPT_TEXT, (_e, text: ReceiptText) => saveReceiptText(text));
  timedHandle(IpcChannels.SAVE_BRAND_COLOR, (_e, color: string | null) => saveBrandColor(color));
  timedHandle(IpcChannels.GET_MY_ACCESS, () => getMyAccess());
  timedHandle(IpcChannels.GET_KOT_BOARD, (_e, userId: string) => getKotBoard(userId));
  timedHandle(IpcChannels.GET_UNPRINTED_KOTS, () => getUnprintedKots());
  timedHandle(IpcChannels.PRINT_KOT_NOW, (_e, orderId: string) => printKotNow(orderId));
  timedHandle(IpcChannels.MOVE_KOT, (_e, orderId: string, to: string, from: string, userId: string) => moveKot(orderId, to, from, userId));
  timedHandle(IpcChannels.MOVE_KOT_ITEMS, (_e, orderId: string, itemIds: string[], to: string, from: string, userId: string) =>
      moveKotItems(orderId, itemIds, to, from, userId),
    );
  timedHandle(IpcChannels.GET_KOT_WORKFLOW, () => getKotWorkflow());
  timedHandle(IpcChannels.SAVE_KOT_WORKFLOW, (_e, w: KotWorkflow) => saveKotWorkflow(w));
  timedHandle(IpcChannels.GET_TAX_RATE, () => getTaxRate());
  timedHandle(IpcChannels.LIST_TAX_RATES, () => listTaxRates());
  timedHandle(IpcChannels.ADD_TAX_RATE, (_e, payload: AddTaxRatePayload) => addTaxRate(payload));
  timedHandle(IpcChannels.DELETE_TAX_RATE, (_e, id: string) => deleteTaxRate(id));
  timedHandle(IpcChannels.PLACE_ORDER, (_e, payload: PlaceOrderPayload) => placeOrder(payload));
  timedHandle(IpcChannels.SAVE_MANAGED_TABLE, (_e, payload: SaveManagedTablePayload) =>
    saveManagedTable(payload),
  );
  timedHandle(
    IpcChannels.SET_MANAGED_TABLE_STATUS,
    (_e, tableId: string, status: ManagedTableStatus) => setManagedTableStatus(tableId, status),
  );
  timedHandle(IpcChannels.SET_MANAGED_TABLE_ACTIVE, (_e, tableId: string, active: boolean) =>
    setManagedTableActive(tableId, active === true),
  );
  timedHandle(IpcChannels.SAVE_ORDER_PAYMENT, (_e, payload: SavePaymentPayload) =>
    savePayment(payload),
  );

  // App updates (updateManager.ts, docs/APP_UPDATES.md)
  timedHandle(IpcChannels.GET_UPDATE_STATUS, () => getUpdateStatus());
  timedHandle(IpcChannels.CHECK_FOR_UPDATES, () => checkForUpdates());
  timedHandle(IpcChannels.GET_INSTALL_CHECK, () => getInstallCheck());
  timedHandle(IpcChannels.INSTALL_UPDATE, () => installUpdate());
  timedHandle(IpcChannels.SET_UPDATE_CHANNEL, (_e, channel: string) =>
    setUpdateChannel(channel === 'beta' ? 'beta' : 'stable'),
  );

  // Desktop alerts (desktopAlerts.ts, docs/DESKTOP_ALERTS.md)
  timedHandle(IpcChannels.GET_ALERTS, () => getAlertSnapshot());
  timedHandle(IpcChannels.MARK_ALERTS_READ, () => markAlertsRead());
  timedHandle(IpcChannels.CLEAR_ALERTS, () => clearAlerts());
  timedHandle(IpcChannels.DISMISS_KOT_ALERT, (_e, orderId: unknown) => dismissKotProblem(String(orderId ?? '')));
  timedHandle(IpcChannels.SAVE_ALERT_SETTINGS, (_e, patch: unknown) => {
    const clean: Partial<AlertSettings> = {};
    const keys: (keyof AlertSettings)[] = ['newOrder', 'kotFailed', 'late', 'sound', 'systemNotification'];
    if (patch && typeof patch === 'object') {
      for (const k of keys) {
        const v = (patch as Record<string, unknown>)[k];
        if (typeof v === 'boolean') clean[k] = v;
      }
    }
    return saveAlertSettings(clean);
  });

  // main -> renderer (forward manager events to the active window)
  const send = (channel: string, payload: unknown) => {
    getWindow()?.webContents.send(channel, payload);
  };

  orderManager.on('order-received', (order) => send(IpcChannels.ORDER_RECEIVED, order));
  orderManager.on('status-changed', (order) => send(IpcChannels.ORDER_STATUS_CHANGED, order));
}
