import { config, saveConfig } from './config.js';

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

let cachedSettings: PrinterConfig = {};
const MAX_PRINTERS = 5;

/**
 * Normalize printer type name (spaces -> underscores, lowercase)
 */
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

/**
 * Load settings from database or local storage
 */
export async function loadSettings(): Promise<PrinterConfig> {
  // Start with environment/local config
  cachedSettings = {
    printer_kitchen: config.kitchenPrinter,
  };

  // Try to fetch from Supabase if configured
  try {
    
    const supabase = null;
     if (supabase) {
    //   const { data, error } = await supabase.from('settings').select('key, value');
    //   if (!error && data) {
    //     const dbSettings = data.reduce(
    //       (acc: PrinterConfig, row: { key: string; value: string }) => {
    //         if (row.key.startsWith('printer_')) {
    //           acc[row.key] = row.value;
    //         }
    //         return acc;
    //       },
    //       {},
    //     );
    //     cachedSettings = { ...cachedSettings, ...dbSettings };
    //   }
    }
  } catch (_err) {
    console.log('Settings: Supabase not available, using local config');
  }

  return cachedSettings;
}

/**
 * Get all printer configurations
 */
export function getAllPrinters(): PrinterConfig {
  return { ...cachedSettings };
}

/**
 * Resolve the device name configured for a printer role, e.g.
 * getPrinterFor('waiter') -> cachedSettings['printer_waiter'].
 * Accepts a plain role ('waiter') or a full key ('printer_waiter').
 * Returns undefined if that role has no printer configured.
 */
export function getPrinterFor(role: string): string | undefined {
  const key = role.startsWith('printer_') ? role : normalizePrinterType(role);
  const value = cachedSettings[key];
  return value && value.trim() ? value.trim() : undefined;
}

/**
 * Add or update a printer configuration
 */
export async function updatePrinter(
  printerType: string,
  deviceName: string,
): Promise<void> {
  const normalized = normalizePrinterType(printerType);

  // Validate max printers
  const existing = Object.keys(cachedSettings).filter((k) => k.startsWith('printer_'))
    .length;
  if (!cachedSettings[normalized] && existing >= MAX_PRINTERS) {
    throw new Error(`Cannot add more than ${MAX_PRINTERS} printers`);
  }

  cachedSettings[normalized] = deviceName;

  // Save to local config (only kitchen printer in env)
  if (normalized === 'printer_kitchen') {
    config.kitchenPrinter = deviceName;
    saveConfig();
  }

  // Try to save to Supabase
  try {
    const supabase = null;
    if (supabase) {
      // const { error } = await supabase.from('settings').upsert(
      //   {
      //     key: normalized,
      //     value: deviceName,
      //     updated_at: new Date().toISOString(),
      //   },
      //   { onConflict: 'key' },
      // );
      // if (error) {
      //   console.error(`Failed to save printer ${normalized}:`, error.message);
      // }
    }
  } catch (_err) {
    console.log('Settings: Could not save to Supabase');
  }
}

/**
 * Remove a printer configuration
 */
export async function removePrinter(printerType: string): Promise<void> {
  const normalized = normalizePrinterType(printerType);

  delete cachedSettings[normalized];

  // Try to remove from Supabase
  try {
    const supabase = null;
    if (supabase) {
      // const { error } = await supabase.from('settings').delete().eq('key', normalized);
      // if (error) {
      //   console.error(`Failed to remove printer ${normalized}:`, error.message);
      // }
    }
  } catch (_err) {
    console.log('Settings: Could not remove from Supabase');
  }
}

/**
 * Get max printers allowed
 */
export function getMaxPrinters(): number {
  return MAX_PRINTERS;
}
