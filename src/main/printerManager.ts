import { execFile } from 'child_process';
import { promisify } from 'util';
import { BrowserWindow } from 'electron';
import { ThermalPrinter, PrinterTypes, CharacterSet } from 'node-thermal-printer';
import { config } from './config';
import { taxBillLines } from '../shared/orderTotals';
import type { FoodOrder, PrinterInfo, HeaderConfig } from '../shared/types';
import { printHtml, renderBillHtml, renderKotHtml, renderTestHtml } from './htmlPrintHelper';
import { printImage } from './imagePrintHelper';
import { journalPrint } from './logger';
import { renderEpsBill, renderEpsKOT, renderTestEPS } from './epsPrintHelper';

const electron = typeof process !== 'undefined' && process.versions && !!process.versions.electron;

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

// ---- Listing printers ----------------------------------------------------

async function listPrintersUnix(): Promise<string[]> {
  try {
    // `lpstat -a` lists accepting printers, one per line: "<name> accepting ..."
    const { stdout } = await execFileAsync('lpstat', ['-a']);
    return stdout
      .split('\n')
      .map((line) => line.trim().split(' ')[0])
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function listPrintersWindows(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      'Get-Printer | Select-Object -ExpandProperty Name',
    ]);
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ---- Virtual / software printer filtering ---------------------------------
// Windows (and macOS/Linux) ship software "printers" that render to a file
// rather than to paper — OneNote, XPS, Print to PDF, Fax, etc. They can never
// drive a thermal head, so they only clutter the picker. Match on substrings,
// case-insensitively, so localized and versioned variants are caught too
// (e.g. "OneNote (Desktop)", "OneNote for Windows 10", "Microsoft Print to PDF").
const VIRTUAL_PRINTER_PATTERNS = [
  'onenote',
  'microsoft print to pdf',
  'microsoft xps document writer',
  'xps document writer',
  'send to onenote',
  'print to pdf',
  'pdfcreator',
  'adobe pdf',
  'cups-pdf',
  'fax',
];

/**
 * True if `name` looks like a software/virtual printer rather than physical
 * hardware.
 */
export function isVirtualPrinter(name: string): boolean {
  const n = name.toLowerCase();
  return VIRTUAL_PRINTER_PATTERNS.some((pattern) => n.includes(pattern));
}

// ---- Printer list cache ---------------------------------------------------
// The status bar and Settings both need the printer list. Listing used to run
// `powershell Get-Printer` (a new process) on every call, and the status bar
// asked every 10 s. Now the names are cached for PRINTER_CACHE_MS, read from
// Electron's own getPrintersAsync() (no child process) when a window exists,
// and the UI is told about changes by startPrinterWatch() over the
// PRINTER_STATUS event instead of polling. PowerShell / lpstat stay as the
// fallback when no window is open yet or Electron returns nothing.
const PRINTER_CACHE_MS = 60_000;
let printerNameCache: { at: number; names: string[] } | null = null;
let printerNamesInFlight: Promise<string[]> | null = null;

async function listPrinterNames(): Promise<string[]> {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (win) {
    try {
      const list = await win.webContents.getPrintersAsync();
      if (list.length > 0) return list.map((p) => p.name);
    } catch (err) {
      console.warn('[printerManager] getPrintersAsync failed; falling back to the OS command:', err instanceof Error ? err.message : err);
    }
  }
  return isWindows ? listPrintersWindows() : listPrintersUnix();
}

async function cachedPrinterNames(refresh: boolean): Promise<string[]> {
  if (!refresh && printerNameCache && Date.now() - printerNameCache.at < PRINTER_CACHE_MS) {
    return printerNameCache.names;
  }
  // Callers arriving together share one lookup.
  printerNamesInFlight ??= listPrinterNames()
    .then((names) => {
      printerNameCache = { at: Date.now(), names };
      return names;
    })
    .finally(() => {
      printerNamesInFlight = null;
    });
  return printerNamesInFlight;
}

/**
 * Printers installed in the OS, without virtual ones (PDF, OneNote...).
 * Served from a 60 s cache; `refresh` reads the OS again (Settings does this
 * when it opens, so a printer installed a moment ago shows up).
 */
export async function getPrinters(refresh = false): Promise<PrinterInfo[]> {
  const names = await cachedPrinterNames(refresh);
  const defaultName = config.cashierPrinter;
  return names
    .filter((name) => !isVirtualPrinter(name))
    .map((name) => ({
      name,
      isDefault: name === defaultName,
      online: true, // OS only lists installed printers; treat listed as available.
    }));
}

let printerWatchTimer: NodeJS.Timeout | null = null;

/**
 * Check the printer list every PRINTER_CACHE_MS and call `onChange` with the
 * new list whenever it differs from the last one sent (a printer added or
 * removed, or the cashier printer changed). Sends the first list straight away.
 */
export function startPrinterWatch(onChange: (printers: PrinterInfo[]) => void): void {
  stopPrinterWatch();
  let last = '';
  const check = async () => {
    try {
      const list = await getPrinters(true);
      const key = JSON.stringify(list);
      if (key !== last) {
        last = key;
        onChange(list);
      }
    } catch (err) {
      console.warn('[printerManager] Printer list check failed:', err instanceof Error ? err.message : err);
    }
  };
  void check();
  printerWatchTimer = setInterval(() => void check(), PRINTER_CACHE_MS);
}

export function stopPrinterWatch(): void {
  if (printerWatchTimer) clearInterval(printerWatchTimer);
  printerWatchTimer = null;
}

// ---- Receipt formatting (80mm thermal, 48-char width) -----------------------

// ---- Rupee symbol emission -------------------------------------------------
// printer.println() encodes text through iconv-lite. No iconv codepage
// contains U+20B9 (₹), so it is substituted with 0x3F ('?') BEFORE the bytes
// ever reach the printer — even on a printer whose font has the glyph.
//
// Three strategies, selected by RUPEE_MODE:
//   'image' — render ₹ as an ESC/POS bit image (raw dot data). Font/codepage
//             independent: works on ANY ESC/POS printer. Default.
//   'byte'  — emit a single raw byte from the printer's own font. Needs the
//             printer-specific RUPEE_CODEPAGE/RUPEE_BYTE (find via
//             probeCodePages() or the self-test). Cheapest, perfectly inline.
//   'text'  — fall back to the ASCII string "Rs.".

interface RawPrinter {
  append(data: Buffer | string): void;
}

// ---- Header / footer config -----------------------------------------------
/**
 * Send a short diagnostic slip to an OS-installed printer to verify it is
 * reachable through the spooler. `target` is the printer name; if omitted,
 * the configured kitchen printer is used.
 *
 * Returns a human-readable success line; throws with a friendly message on
 * failure so the UI can surface it directly.
 */
// export async function testPrint(target?: string): Promise<string> {
//   const name = (target ?? config.cashierPrinter ?? '').trim();

//   if (!name) {
//     throw new Error('No printer selected. Choose a printer first.');
//   }

//   try {
//     const printer = loadPrinterDriver(name);

//     const connected = await printer.isPrinterConnected();
//     if (!connected) {
//       throw new Error(
//         `Printer "${name}" was not found or is unavailable. Check it is installed in the OS and the name matches exactly.`,
//       );
//     }

//     printer.alignCenter();
//     printer.bold(true);
//     printer.setTextSize(1, 1);
//     printer.println('TEST PRINT');
//     printer.bold(false);
//     printer.setTextSize(0, 0);
//     solidLine(printer);
//     printer.alignLeft();
//     printer.println(`Printer : ${name}`);
//     printer.println(`Time    : ${new Date().toLocaleString('en-IN')}`);
//     printer.println('Status  : Spooler OK');
//     solidLine(printer);
//     printer.alignCenter();
//     printer.println('If you can read this,');
//     printer.println('the printer is configured correctly.');
//     printer.println('');
//     printer.println('');
//     printer.cut();

//     await printer.execute();
//     return `Test slip sent to "${name}"`;
//   } catch (err) {
//     let message = 'Test print failed';
//     if (err instanceof Error) {
//       message = err.message;
//       if (message.includes('No driver set')) {
//         message = `Print driver not initialized. The @timokunze/node-printer module is missing or not rebuilt for Electron.`;
//       } else if (/not found|unavailable|NOT-AVAILABLE/i.test(message)) {
//         message = `Printer "${name}" not found in the OS spooler. Verify the name matches Get-Printer / lpstat -p exactly and the printer is online.`;
//       }
//     }
//     throw new Error(message);
//   }
// }
 
/**
 * Parse the header config, which may arrive as a JSON string or an already
 * parsed object. Returns null if it can't be parsed.
 */
export function parseHeaderConfig(input: unknown): HeaderConfig | null {
  if (!input) return null;
  let obj: unknown = input;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : v == null ? undefined : String(v);
  return {
    restaurantName: str(o.restaurantName),
    headerText: str(o.headerText),
    footerText: str(o.footerText),
    containerChargePercent: str(o.containerChargePercent),
  };
}
 
/**
 * Split a text value on `<br>` (any case, any surrounding whitespace) into
 * individual lines, trimmed, with empty lines dropped. Each returned line is
 * meant to be printed as its own println.
 */
export function splitBrLines(text?: string): string[] {
  if (!text) return [];
  return text
    .split(/\s*<br\s*\/?>\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}



/**
 * Lines under the business name on a bill. The outlet's own lines (Settings > Receipt)
 * win; otherwise the legacy header config, otherwise address and "city | phone | GST".
 */
export function billHeaderLines(order: FoodOrder): string[] {
  const own = (order.outlet?.receiptHeader ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (own.length > 0) return own;
  const legacy = splitBrLines(parseHeaderConfig(order.headerConfig)?.headerText);
  if (legacy.length > 0) return legacy;
  const lines: string[] = [];
  if (order.outlet?.address) lines.push(order.outlet.address);
  const meta = [order.outlet?.city, order.outlet?.phone, order.outlet?.gstNumber].filter(Boolean).join(' | ');
  if (meta) lines.push(meta);
  return lines;
}

/** Lines above "Thank you!" on a bill: the outlet's own footer, else the legacy footer config. */
export function billFooterLines(order: FoodOrder): string[] {
  const own = (order.outlet?.receiptFooter ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return own.length > 0 ? own : splitBrLines(parseHeaderConfig(order.headerConfig)?.footerText);
}

// ---- Printing (ESC/POS format) -----------------------------------------------
 
/**
 * Print order using ESC/POS format directly to a thermal printer.
 * Requires a connected USB or network thermal printer.
 */
export async function printOrderEscpos(order: FoodOrder, printerName:string, isDuplicate = false): Promise<void> {
  return journalPrint(
    {
      job: 'bill',
      printer: config.cashierPrinter ?? '',
      method: config.printMethod,
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderNumbers: order.orderNumbers,
      items: order.items?.length,
      duplicate: isDuplicate,
    },
    () => printOrderNow(order, printerName, isDuplicate),
  );
}
async function printOrderNow(order: FoodOrder, printerName:string, isDuplicate: boolean): Promise<void> {
  // Validate printer is configured
  if (!printerName || printerName.trim() === '') {
    throw new Error('No printer configured. Set KITCHEN_PRINTER in .env.local');
  }

  if (config.printMethod === 'html') {
    await printHtml(renderBillHtml(order, isDuplicate), printerName);
    return;
  }
  if (config.printMethod === 'image') {
    await printImage(renderBillHtml(order, isDuplicate), printerName);
    return;
  }
  await renderEpsBill(order, printerName, isDuplicate);
  return;
}

/**
 * Print a KOT (Kitchen Order Ticket) to a specific printer.
 *
 * A KOT is intentionally minimal — no prices, no branding — just what the
 * kitchen/waiter needs to prepare and route the order: table number, items
 * with quantities, and the total quantity. `printerName` is the resolved
 * device (typically the waiter printer).
 */
export async function printKot(order: FoodOrder, printerName: string): Promise<void> {
  return journalPrint(
    {
      job: 'kot',
      printer: printerName ?? '',
      method: config.printMethod,
      orderId: order.id,
      orderNumber: order.orderNumber,
      items: order.items?.length,
    },
    () => printKotNow(order, printerName),
  );
}

async function printKotNow(order: FoodOrder, printerName: string): Promise<void> {
  const name = (printerName ?? '').trim();

  if (!name) {
    throw new Error(
      'No waiter printer configured. Add a "Waiter" printer in Settings to print KOTs.',
    );
  }

  if (config.printMethod === 'html') {
    await printHtml(renderKotHtml(order), name);
    return;
  }
  if (config.printMethod === 'image') {
    await printImage(renderKotHtml(order), name);
    return;
  }
  
  await renderEpsKOT(order, printerName);
  return;
  
}
 
// Helper functions
/**
 * Send a short diagnostic slip to an OS-installed printer to verify it is
 * reachable through the spooler. `target` is the printer name; if omitted,
 * the configured kitchen printer is used.
 *
 * Returns a human-readable success line; throws with a friendly message on
 * failure so the UI can surface it directly.
 */
export async function testPrint(target?: string): Promise<string> {
  const name = (target ?? config.cashierPrinter ?? '').trim();
  return journalPrint({ job: 'test', printer: name, method: config.printMethod }, () => testPrintNow(name));
}

async function testPrintNow(name: string): Promise<string> {
  if (!name) {
    throw new Error('No printer selected. Choose a printer first.');
  }

  if (config.printMethod === 'html') {
    await printHtml(renderTestHtml(name), name);
    return `Test slip (HTML) sent to "${name}"`;
  }
  
  if (config.printMethod === 'image') {
    const address = config.printerAddresses[name];
    await printImage(renderTestHtml(name, address ? `Image (ESC/POS) to ${address}` : 'Image (ESC/POS) via Windows'), name);
    return `Test slip (Image) sent to "${name}"${address ? ` at ${address}` : ''}`;
  }

  await renderTestEPS(name);
  return `Test slip sent to "${name}"`;  
}
