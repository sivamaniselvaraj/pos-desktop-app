import { execFile } from 'child_process';
import { promisify } from 'util';
import { BrowserWindow } from 'electron';
import { config } from './config';
import type { FoodOrder, PrinterInfo, HeaderConfig,PrintJobKind, PrintMethod, PrinterSetup } from '../shared/types';
import { printHtml, renderBillHtml, renderKotHtml, renderTestHtml } from './htmlPrintHelper';
import { printImage } from './imagePrintHelper';
import { printBillEscPos, printKotEscPos, testPrintEscPos } from './epsPrintHelper';
import { journalPrint, type PrintJournalEntry } from './logger';

import {
  describePrinter,
  findPrinterSetup,
  JOB_LABELS,
  printersFor,
  validatePrinterSetup,
} from './printerSetups';

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
  const defaultName = printersFor('bill')[0]?.device ?? '';
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

// ---- Header / footer config -----------------------------------------------

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

// ---- Bill header / footer lines --------------------------------------------

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

// ---- Printing (method dispatch) --------------------------------------------
//
// Each job goes to every printer in Settings > Printers that has it
// (printerSetups.ts). A printer with a network address prints as an image
// straight to that IP; any other printer uses the chosen print method on its
// OS printer. Printers are sent to at the same time and journalled one by one.

/** What happened on each printer for one job. */
export interface PrintOutcome {
  printed: string[];
  failed: { printer: string; error: string }[];
}

function methodFor(p: PrinterSetup): PrintMethod {
  return p.address ? 'image' : config.printMethod;
}

/** Send one job to one printer with the right method. */
async function printOn(p: PrinterSetup, html: () => string, escpos: (device: string) => Promise<void>): Promise<void> {
  if (p.address) return printImage(html(), { label: p.label, device: p.device, address: p.address });
  if (!p.device) throw new Error(`Printer "${p.label}" has no installed printer or network address. Check Settings > Printers.`);
  const method = config.printMethod;
  if (method === 'html') return printHtml(html(), p.device);
  if (method === 'image') return printImage(html(), { label: p.label, device: p.device, address: '' });
  return escpos(p.device);
}

/**
 * Print on every target. Resolves when at least one printer printed (the
 * outcome lists any that failed); rejects when none did.
 */
async function printOnAll(
  targets: PrinterSetup[],
  details: Omit<PrintJournalEntry, 'ok' | 'ms' | 'error' | 'printer' | 'method'>,
  html: () => string,
  escpos: (device: string) => Promise<void>,
): Promise<PrintOutcome> {
  const results = await Promise.allSettled(
    targets.map((p) =>
      journalPrint({ ...details, printer: p.address || p.device || p.label, method: methodFor(p) }, () =>
        printOn(p, html, escpos),
      ),
    ),
  );
  const outcome: PrintOutcome = { printed: [], failed: [] };
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') outcome.printed.push(targets[i].label);
    else outcome.failed.push({ printer: targets[i].label, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });
  if (outcome.printed.length === 0) {
    const f = outcome.failed;
    throw new Error(f.length === 1 ? f[0].error : f.map((x) => `${x.printer}: ${x.error}`).join(' | '));
  }
  if (outcome.failed.length > 0) {
    console.warn(`[printerManager] ${details.job} printed on ${outcome.printed.join(', ')} but failed on`, outcome.failed);
  }
  return outcome;
}

/**
 * Print a bill on every printer that prints bills. isDuplicate prints a
 * "DUPLICATE BILL" heading after the header. Callers set it when the order's
 * bill has printed before (orders.is_printed), and record the print afterwards
 * with recordBillPrinted (orderManager.ts). Rejects only when no printer printed it.
 */
export async function printOrder(order: FoodOrder, isDuplicate = false): Promise<PrintOutcome> {
  const targets = printersFor('bill');
  if (targets.length === 0) {
    throw new Error('No printer prints bills. In Settings > Printers, tick "Bill" on a printer.');
  }
  return printOnAll(
    targets,
    {
      job: 'bill',
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderNumbers: order.orderNumbers,
      items: order.items?.length,
      duplicate: isDuplicate,
    },
    () => renderBillHtml(order, isDuplicate),
    (device) => printBillEscPos(order, device, isDuplicate),
  );
}

/** The job a KOT for this order is: dine-in, or takeaway and delivery. */
export function kotJobFor(order: Pick<FoodOrder, 'orderType'>): PrintJobKind {
  return order.orderType === 'dine-in' ? 'kot-dine-in' : 'kot-takeaway';
}

/**
 * Print a KOT (Kitchen Order Ticket) on every printer that prints this kind
 * of KOT (dine-in, or takeaway and delivery).
 *
 * A KOT is intentionally minimal — no prices, no branding — just what the
 * kitchen/waiter needs to prepare and route the order: table number, items
 * with quantities, and the total quantity. Rejects only when no printer printed it.
 */

export async function printKot(order: FoodOrder): Promise<PrintOutcome> {
  const job = kotJobFor(order);
  const targets = printersFor(job);
  if (targets.length === 0) {
    throw new Error(`No printer prints ${JOB_LABELS[job]}s. In Settings > Printers, tick "${JOB_LABELS[job]}" on a printer.`);
  }
  return printOnAll(
    targets,
    { job: 'kot', orderId: order.id, orderNumber: order.orderNumber, items: order.items?.length },
    () => renderKotHtml(order),
    (device) => printKotEscPos(order, device),
  );
}

/**
 * Send a short diagnostic slip to one printer. `target` is a printer's id or
 * name in the list, or an OS printer name; if omitted, the first printer that
 * prints bills is used.
 *
 * Returns a human-readable success line; throws with a friendly message on
 * failure so the UI can surface it directly.
 */
export async function testPrint(target?: string): Promise<string> {
  const t = (target ?? '').trim();
  const setup =
    (t ? findPrinterSetup(t) : printersFor('bill')[0]) ??
    (t ? { id: '', label: t, device: t, address: '', jobs: [] } : undefined);
  if (!setup) throw new Error('No printer selected. Choose a printer first.');
  return testOn(setup);
}

/** Test slip to a printer as entered in Settings (saved or not). */
export async function testPrinterSetup(input: unknown): Promise<string> {
  const p = input as Partial<PrinterSetup>;
  const setup: PrinterSetup = {
    id: String(p?.id ?? ''),
    label: String(p?.label ?? '').trim() || String(p?.address ?? p?.device ?? '').trim(),
    device: String(p?.device ?? '').trim(),
    address: String(p?.address ?? '').trim(),
    jobs: [],
  };
  validatePrinterSetup(setup);
  return testOn(setup);
}

async function testOn(p: PrinterSetup): Promise<string> {
  const method = methodFor(p);
  const methodText = p.address
    ? `Image (ESC/POS) to ${p.address}`
    : method === 'image'
      ? 'Image (ESC/POS) via Windows'
      : method === 'html'
        ? 'HTML (Electron)'
        : 'Direct (ESC/POS)';
  return journalPrint({ job: 'test', printer: p.address || p.device || p.label, method }, async () => {
    if (method === 'direct' && !p.address) {
      if (!p.device) throw new Error('No printer selected. Choose a printer first.');
      return testPrintEscPos(p.device);
    }
    await printOn(p, () => renderTestHtml(p.label || p.device || p.address, methodText), async () => undefined);
    return `Test slip sent to ${describePrinter(p)} (${methodText})`;
  });
}
