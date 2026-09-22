import { config, saveConfig } from './config';

/**
 * Settings Manager - Multi-Printer Configuration
 *
 * Handles reading/writing printer configurations.
 * Stores multiple printers: kitchen_printer, cashier_printer, etc.
 * Format: { printer_type: "device_name", ... }
 */

interface PrinterConfig {
  [key: string]: string; // e.g., kitchen_printer: "USB001"
}

const FIXED_ROLES = ['cashier', 'waiter', 'kitchen'] as const;
type PrinterRole = (typeof FIXED_ROLES)[number];

const ROLE_TO_CONFIG_KEY: Record<PrinterRole, 'cashierPrinter' | 'waiterPrinter' | 'kitchenPrinter'> = {
  cashier: 'cashierPrinter',
  waiter: 'waiterPrinter',
  kitchen: 'kitchenPrinter',
};

/** Normalize a printer role name (spaces -> underscores, lowercase, `printer_` prefix). */
export function normalizePrinterType(name: string): string {
  return `printer_${name.toLowerCase().trim().replace(/\s+/g, '_')}`;
}

/**
 * Display printer type name (remove prefix, underscores -> spaces, title case)
 */
export function displayPrinterType(name: string): string {
  const cleaned = name.replace(/^printer_/, '').replace(/_/g, ' ');
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

function roleFromKey(key: string): PrinterRole | undefined {
  const normalized = key.startsWith('printer_') ? key : normalizePrinterType(key);
  const bare = normalized.replace(/^printer_/, '');
  return (FIXED_ROLES as readonly string[]).includes(bare) ? (bare as PrinterRole) : undefined;
}

/**
 * Kept as an async function returning the current mapping so index.ts's
 * existing `await loadSettings()` call site didn't need to change. There's
 * nothing to actually preload anymore — config.ts's getters read the file
 * fresh on every access, so there's no cache to warm at startup.
 */
export async function loadSettings(): Promise<PrinterConfig> {
  return getAllPrinters();
}

export function getAllPrinters(): PrinterConfig {
  return {
    printer_cashier: config.cashierPrinter,
    printer_waiter: config.waiterPrinter,
    printer_kitchen: config.kitchenPrinter,
  };
}

/**
 * Resolve the device name configured for a printer role, e.g.
 * getPrinterFor('waiter') -> cachedSettings['printer_waiter'].
 * Accepts a plain role ('waiter') or a full key ('printer_waiter').
 * Returns undefined if that role has no printer configured.
 */
export function getPrinterFor(role: string): string | undefined {
  const printerRole = roleFromKey(role);
  if (!printerRole) return undefined;
  const value = config[ROLE_TO_CONFIG_KEY[printerRole]];
  return value && value.trim() ? value.trim() : undefined;
}

/** Save a printer's device name for one of the three fixed roles (Cashier/Waiter/Kitchen). */
export async function updatePrinter(printerType: string, deviceName: string): Promise<void> {
  const printerRole = roleFromKey(printerType);
  if (!printerRole) {
    throw new Error(
      `Unknown printer role "${printerType}" — expected Cashier, Waiter, or Kitchen.`,
    );
  }
  config[ROLE_TO_CONFIG_KEY[printerRole]] = deviceName;
  }

/** Clears a role's printer mapping. Kept for backward compatibility with the existing IPC channel. */
export async function removePrinter(printerType: string): Promise<void> {
  const printerRole = roleFromKey(printerType);
  if (!printerRole) return;
  config[ROLE_TO_CONFIG_KEY[printerRole]] = '';
}

/** Three fixed roles now, not an arbitrary add-more-printers limit. */
export function getMaxPrinters(): number {
  return FIXED_ROLES.length;
}
