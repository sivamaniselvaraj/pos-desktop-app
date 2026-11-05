import { execFile } from 'child_process';
import { promisify } from 'util';
import { BrowserWindow } from 'electron';
import { ThermalPrinter, PrinterTypes, CharacterSet } from 'node-thermal-printer';
import { config } from './config';
import { taxBillLines } from '../shared/orderTotals';
import type { FoodOrder, PrinterInfo, HeaderConfig } from '../shared/types';
import { printHtml, renderBillHtml, renderKotHtml, renderTestHtml } from './htmlPrint';
import { journalPrint } from './logger';

const electron = typeof process !== 'undefined' && process.versions && !!process.versions.electron;

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

// ---- OS spooler driver ---------------------------------------------------
// node-thermal-printer's `printer:Name` interface needs a native driver
// injected via the `driver` option; the library ships none (that's the
// "No driver set!" error). We use @timokunze/node-printer, the maintained
// fork. It's a native addon compiled per-platform/Electron ABI, so it may be
// absent or unbuilt in some environments — load it lazily and fail with a
// clear, actionable message rather than crashing at startup.
let cachedDriver: object | null = null;
 
function loadPrinterDriver(printerName: string): ThermalPrinter {
   const printer = new ThermalPrinter({
      type: PrinterTypes.CUSTOM,
      interface: 'printer:' + printerName,
      driver: require(electron ? '@timokunze/node-printer' : 'printer') as object,
      characterSet: CharacterSet.WPC1252,
      lineCharacter: '-', // must be single-byte ASCII: drawLine() does no codepage conversion
      width: RECEIPT_WIDTH,
    });
    return printer;
}


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
const RUPEE_MODE: 'image' | 'byte' | 'text' = 'image';
const RUPEE_CODEPAGE: number | null = 0xB9; // ESC t <n>; null = leave codepage as-is
const RUPEE_BYTE: number | null = 0xBD; // e.g. 0xD5 — set after probing

const ESC = 0x1b;

interface RawPrinter {
  append(data: Buffer | string): void;
}

/** Emit raw bytes, bypassing the iconv text encoder. */
function raw(printer: RawPrinter, bytes: any[]): void {
  printer.append(Buffer.from(bytes));
}

/** Select a printer code page (ESC t n). */
function selectCodePage(printer: RawPrinter, n: number): void {
  raw(printer, [ESC, 0x74, n]);
}

// Rupee glyph as a 12-wide x 24-tall bitmap, authored row-major for
// readability (MSB = leftmost column). Sized to ~one Font-A character cell so
// it slots into the monospace columns without disturbing alignment. Tweak the
// dots here if the printed shape needs refining.
// prettier-ignore
const RUPEE_GLYPH_ROWS: string[] = [
  '000000000000',
  '001111111000',
  '001111111000',
  '000000000000',
  '001111111000',
  '001111111000',
  '001100011000',
  '001100011000',
  '001111111000',
  '001111111000',
  '001100000000',
  '001100000000',
  '000110000000',
  '000011000000',
  '000001100000',
  '000000110000',
  '000000011000',
  '000000001100',
  '000000000110',
  '000000000000',
  '000000000000',
  '000000000000',
  '000000000000',
  '000000000000',
];

// Build the ESC * (bit image) command for the rupee glyph once.
// ESC * m=32 (24-dot single density): 3 bytes per column, bit7=top row.
let cachedRupeeImage: Buffer | null = null;

function buildRupeeImage(): Buffer {
  if (cachedRupeeImage) return cachedRupeeImage;

  const rows = RUPEE_GLYPH_ROWS;
  const height = rows.length; // 24
  const width = rows[0].length; // 12
  const bytesPerCol = Math.ceil(height / 8); // 3

  const data: number[] = [];
  for (let col = 0; col < width; col++) {
    for (let band = 0; band < bytesPerCol; band++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const row = band * 8 + bit;
        if (row < height && rows[row][col] === '1') {
          byte |= 0x80 >> bit; // bit7 = topmost row of the band
        }
      }
      data.push(byte);
    }
  }

  // ESC * m nL nH  d1..dk    (m=32 -> 24-dot single density)
  const nL = width & 0xff;
  const nH = (width >> 8) & 0xff;
  cachedRupeeImage = Buffer.from([ESC, 0x2a, 32, nL, nH, ...data]);
  return cachedRupeeImage;
}

/** Emit the rupee glyph inline as a raw bit-image buffer. */
function emitRupeeImage(printer: RawPrinter): void {
  printer.append(buildRupeeImage());
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
//         message = `Print driver not initialized. The @grandchef/node-printer module is missing or not rebuilt for Electron.`;
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


// ---- Receipt layout --------------------------------------------------------
// Column widths must sum to exactly RECEIPT_WIDTH (48) or rows overflow and
// the printer hard-wraps them, breaking alignment.
const RECEIPT_WIDTH = 48;
const ITEM_COL = 20; // left
const QTY_COL = 4; // right
const PRICE_COL = 12; // right
const AMT_COL = 12; // right
const INFO_COL =  RECEIPT_WIDTH - AMT_COL;
// 22 + 4 + 12 + 12 = 48

/**
 * Break `text` into lines of at most `width` chars, preferring word
 * boundaries and hard-splitting any single word longer than `width`.
 * Always returns at least one line.
 */
function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (word.length > width) {
      // A single word too long for the column: flush, then hard-split it.
      if (current) {
        lines.push(current);
        current = '';
      }
      let rest = word;
      while (rest.length > width) {
        lines.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      current = rest;
      continue;
    }

    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= width) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines;
}
function formatCurrency(amount: number): string {
  return `₹ ${amount.toFixed(2)}`;
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

  try {

     // Print through the OS spooler. node-thermal-printer's `printer:Name`
    // interface hands the raw ESC/POS buffer to the injected driver, which
    // submits it to the Windows spooler / CUPS as a RAW job. The printer must
    // be installed in the OS as a RAW/generic-text device so bytes pass
    // through untouched. `Name` must match the OS printer name exactly
    // (Get-Printer on Windows, lpstat -p on macOS/Linux).
    const printer = loadPrinterDriver(printerName);
    const isConnected = await printer.isPrinterConnected();

     if (!isConnected) {
      throw new Error(
        `Printer "${printerName}" was not found or is unavailable. Check it is installed in the OS (Get-Printer / lpstat -p) and the name matches exactly.`,
      );
    }
    
    // Build receipt header. Prefer the JSON headerConfig (restaurantName +
    // headerText with <br> line breaks); fall back to outlet fields.
    const header = parseHeaderConfig(order.headerConfig);
 
    printer.alignCenter();
    printer.setTextSize(1, 1);
    printer.bold(true);
    printer.println(order.outlet?.name || 'Virunthagam');
    printer.bold(false);
    printer.setTextSize(0, 0);

    for (const hl of billHeaderLines(order)) printer.println(hl);

    printer.setTextSize(0, 0);
    solidLineThick(printer);

     if (isDuplicate) {
          printer.alignCenter();
          printer.bold(true);
          printer.invert(true);
          printer.println(' DUPLICATE BILL ');
          printer.invert(false);
          printer.bold(false);
          solidLineThick(printer);
        }
    
    if(order.customerName.trim() !== '' && order.customerName !== 'Unknown'){
      printer.alignLeft();
      printer.println(`Name: ${order.customerName}`);
      solidLineThick(printer);
    }
    //printer.println('');

    const dateTime = new Date(order.createdAt).toLocaleString('en-IN', {day:'2-digit', month: '2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false});
    // printer.println(formatKeyValue('Date', dateTime));
    // printer.println(formatKeyValue('Bill No.', String(order.orderNumber)));
    // printer.println(formatKeyValue('Type', order.orderType.toUpperCase()));
    // printer.println(formatKeyValue('Token No.', String(order.tokenNumber)));

    const orderType = order.orderType === "pickup" || order.orderType === "takeaway" ? "Pick Up" : "Dine In";

    printer.tableCustom([                                       // Prints table with custom settings (text, align, width, cols, bold)
      { text:formatKeyValue('Date', dateTime), align:"LEFT"},
      { text:orderType.toUpperCase(), align:"LEFT", bold:true},
    ]);
    printer.tableCustom([                                       // Prints table with custom settings (text, align, width, cols, bold)
      { text:"", align:"LEFT"},
      { text:formatKeyValue('Bill No.', String(order.orderNumbers)), align:"LEFT", bold:true},
    ]);
    if(orderType === "Pick Up"){
      printer.tableCustom([                                       // Prints table with custom settings (text, align, width, cols, bold)
        { text:formatKeyValue('Token No.', String(order.orderNumbers)), align:"LEFT", bold:true},
        { text:"", align:"LEFT"},
      ]);
    }

    if (order.customerPhone) printer.println(formatKeyValue('Phone', order.customerPhone));
    if (order.deliveryAddress) printer.println(formatKeyValue('Address', order.deliveryAddress));

    solidLine(printer);

    let totalQty = 0;
   
    printer.tableCustom([                                       // Prints table with custom settings (text, align, width, cols, bold)
      { text:"Item", align:"LEFT", cols:ITEM_COL, bold:true },
      { text:"Qty", align:"CENTER", cols:QTY_COL, bold:true },
      { text:"Price", align:"RIGHT", cols:PRICE_COL , bold:true},
      { text:"Amount", align:"RIGHT", cols:AMT_COL , bold:true}
    ]);
    solidLine(printer);
    for (const item of order.items) {
      totalQty += item.quantity;
      const qtyStr = String(item.quantity);
      const priceStr = formatCurrency(item.unitPrice);
      const amountStr = formatCurrency(item.unitPrice * item.quantity);

      // First line carries the numeric columns; remaining name lines are
      // indented continuations.
    const nameLines = wrapText(item.name, ITEM_COL);
    printer.tableCustom([                                       // Prints table with custom settings (text, align, width, cols, bold)
      { text:nameLines[0], align:"LEFT", cols:ITEM_COL, bold:false },
      { text:qtyStr, align:"CENTER", cols:QTY_COL, bold:false },
      { text:priceStr, align:"RIGHT", cols:PRICE_COL , bold:false},
      { text:amountStr, align:"RIGHT", cols:AMT_COL , bold:false}
    ]);
    }
    solidLine(printer);
    printer.tableCustom([                                       
      { text: "Total Qty", align:"RIGHT", cols:INFO_COL, bold:false },
      { text: String(totalQty), align:"RIGHT", cols:AMT_COL, bold:false },
    ]);
    printer.tableCustom([                                       
      { text: "Sub Total", align:"RIGHT",  cols:INFO_COL, bold:true },
      { text: formatCurrency(order.subtotal), align:"RIGHT", cols:AMT_COL, bold:true },
    ]);
    if(orderType === "Pick Up" && order.containerCharge && order.containerCharge > 0){
      printer.tableCustom([                                       
        { text: "Container Charge", align:"RIGHT",  cols:INFO_COL, bold:true },
        { text: formatCurrency(order.containerCharge??0), align:"RIGHT", cols:AMT_COL, bold:true },
      ]);
    }

    for (const t of taxBillLines(order.taxBreakdown, order.tax)) {
    printer.tableCustom([                                      
      { text: t.label, align:"RIGHT", cols:INFO_COL, bold:true },
      { text: formatCurrency(t.amount), align:"RIGHT", cols:AMT_COL, bold:true },
    ]);
    }

    if (order.discount && order.discount > 0) {
       printer.tableCustom([                                       // Prints table with custom settings (text, align, width, cols, bold)
        { text: "Discount", align:"RIGHT", cols:INFO_COL, bold:true },
        { text: formatCurrency(order.discount), align:"RIGHT", cols:AMT_COL, bold:true },
      ]);
      //line(printer, formatKeyValue('Discount', '-' + formatCurrency(order.discount)));
    }

    solidLineThick(printer);

  let grandTotal = Number.parseInt(order?.total.toString());
  let roundOff = (grandTotal - order.total).toFixed(2);

    printer.tableCustom([                                       // Prints table with custom settings (text, align, width, cols, bold)
      { text: "Round off", align:"RIGHT", cols:INFO_COL, bold:false },
      { text: roundOff, align:"RIGHT", cols:AMT_COL, bold:false },
    ]);
    printer.tableCustom([                                       // Prints table with custom settings (text, align, width, cols, bold)
      { text: "Grand Total", align:"RIGHT", cols:INFO_COL, bold:true },
      { text: formatCurrency(grandTotal), align:"RIGHT", cols:AMT_COL, bold:true },
    ]);

    solidLineThick(printer);

    if (order.specialNotes) {
      printer.alignCenter();
      printer.bold(true);
      printer.println('Special Notes');
      printer.bold(false);
      printer.alignLeft();
      printer.println(order.specialNotes);
      printer.println('');
    }

    printer.alignCenter();
    const footerLines = billFooterLines(order);
    for (const fl of footerLines) printer.println(fl);
    if (footerLines.length > 0) printer.println('');

    solidLine(printer);
    printer.println('');
    printer.println('');

    await printer.execute();
  } catch (err) {
    let message = 'Failed to print';

    if (err instanceof Error) {
      message = err.message;

      // Enhance common spooler errors
      if (message.includes('No driver set')) {
        message = `Print driver not initialized for "${printerName}". The @timokunze/node-printer module is missing or not rebuilt for Electron.`;
      } else if (/not found|unavailable|NOT-AVAILABLE/i.test(message)) {
        message = `Printer "${printerName}" not found in the OS spooler. Verify the name matches Get-Printer / lpstat -p exactly and the printer is online.`;
      }
    }

    throw new Error(message);
  }
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
  let isPickup = order.orderType === "pickup" || order.orderType === 'takeaway';
  let kotTitle = isPickup  ? 'TAKEAWAY' : 'WAITER KOT';
  let orderType = isPickup ? "Pick Up" : "Dine In";

    const tableLabel =
      order.tableNumber != null && String(order.tableNumber).trim() !== ''
        ? String(order.tableNumber)
        : '-';

  if (!name) {
    throw new Error(
      'No waiter printer configured. Add a "Waiter" printer in Settings to print KOTs.',
    );
  }

  if (config.printMethod === 'html') {
    await printHtml(renderKotHtml(order), name);
    return;
  }

  try {
    const printer = loadPrinterDriver(printerName);
    const connected = await printer.isPrinterConnected();
    if (!connected) {
      throw new Error(
        `Printer "${name}" was not found or is unavailable. Check it is installed in the OS and the name matches exactly.`,
      );
    }

    // Title
    printer.alignCenter();
    printer.bold(true);
    printer.setTextSize(1, 1);
    printer.println(kotTitle);
    printer.setTextSize(0, 0);

    // A dine-in round added to a table that already has orders: tell the kitchen it is a running order.
    if (order.orderType !== 'pickup' && order.isRunningOrder) {
      printer.bold(true);
      printer.println('** RUNNING ORDER **');
    }
    printer.bold(false);
    solidLine(printer);
    printer.println(`Time   : ${new Date(order.createdAt).toLocaleString('en-IN')}`);
    if(order.orderNumber){
      printer.println("KOT - " + order.orderNumber);
    }

    printer.bold(true);
    printer.println(orderType);
    if(!isPickup){ 
      printer.setTextSize(1, 1);
      printer.println(`Table No: ${tableLabel}`);
    }
    printer.setTextSize(0, 0);
    printer.bold(false);
    solidLine(printer);
    printer.println(order.placedBy? order.placedBy : 'Biller');
    solidLine(printer);

    // Items — quantity emphasised, no prices on a KOT.
    let totalQty = 0;
    const ITEM_COL =  RECEIPT_WIDTH -  QTY_COL
    printer.tableCustom([                                       // Prints table with custom settings (text, align, width, cols, bold)
      { text:"Item", align:"LEFT", cols:ITEM_COL, bold:true },
      { text:"Qty", align:"CENTER", cols:QTY_COL, bold:true }
    ]);

    for (const item of order.items) {
      totalQty += item.quantity;
      const qtyStr = String(item.quantity);;
      const nameLines = wrapText(item.name, RECEIPT_WIDTH - 5);
      printer.tableCustom([                                       // Prints table with custom settings (text, align, width, cols, bold)
      { text:nameLines[0], align:"LEFT", cols:ITEM_COL, bold:false },
      { text:qtyStr, align:"CENTER", cols:QTY_COL, bold:false },
    ]);
      if (item.specialInstructions) {
        printer.println('     * ' + item.specialInstructions);
      }
    }

    solidLine(printer);

    printer.tableCustom([                                       // Prints table with custom settings (text, align, width, cols, bold)
      { text:"", align:"LEFT", cols:ITEM_COL, bold:true },
      { text:String(totalQty), align:"CENTER", cols:QTY_COL, bold:true }
    ]);

    if (order.specialNotes) {
      solidLine(printer);
      printer.bold(true);
      printer.println('Notes:');
      printer.bold(false);
      printer.println(order.specialNotes);
    }
    solidLine(printer);
    printer.cut();

    await printer.execute();
  } catch (err) {
    let message = 'Failed to print KOT';
    if (err instanceof Error) {
      message = err.message;
      if (message.includes('No driver set')) {
        message = `Print driver not initialized for "${name}". The @grandchef/node-printer module is missing or not rebuilt for Electron.`;
      } else if (/not found|unavailable|NOT-AVAILABLE/i.test(message)) {
        message = `Printer "${name}" not found in the OS spooler. Verify the name matches Get-Printer / lpstat -p exactly and the printer is online.`;
      }
    }
    throw new Error(message);
  }
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

  try {

    const printer = loadPrinterDriver(name);


    const connected = await printer.isPrinterConnected();
    if (!connected) {
      throw new Error(
        `Printer "${name}" was not found or is unavailable. Check it is installed in the OS and the name matches exactly.`,
      );
    }

    printer.alignCenter();
    printer.bold(true);
    printer.setTextSize(1, 1);
    printer.println('TEST PRINT');
    printer.bold(false);
    printer.setTextSize(0, 0);
    solidLine(printer);
    printer.alignLeft();
    printer.println(`Printer : ${name}`);
    printer.println(`Time    : ${new Date().toLocaleString('en-IN')}`);
    printer.println('Status  : Spooler OK');
    solidLine(printer);
    printer.alignCenter();
    printer.println('If you can read this,');
    printer.println('the printer is configured correctly.');
    printer.println('');
    printer.println('');
    printer.cut();

    await printer.execute();
    return `Test slip sent to "${name}"`;
  } catch (err) {
    let message = 'Test print failed';
    if (err instanceof Error) {
      message = err.message;
      if (message.includes('No driver set')) {
        message = `Print driver not initialized. The @timokunze/node-printer module is missing or not rebuilt for Electron.`;
      } else if (/not found|unavailable|NOT-AVAILABLE/i.test(message)) {
        message = `Printer "${name}" not found in the OS spooler. Verify the name matches Get-Printer / lpstat -p exactly and the printer is online.`;
      }
    }
    throw new Error(message);
  }
}

// ---- Solid rules (ESC/POS) -------------------------------------------------
// NOTE: printer.drawLine() appends its character with Buffer.from(), with NO
// codepage conversion. A multi-byte character such as '─' (U+2500) therefore
// emits its 3 raw UTF-8 bytes (E2 94 80) per column and prints as garbage.
// Only single-byte ASCII is safe with drawLine().
//
// To get a genuinely SOLID (unbroken) rule we don't use a character at all —
// we switch on a print mode and emit spaces, so the printer fills the row
// itself. This is codepage-independent and works on any ESC/POS device.


// Minimal structural type: avoids depending on the library's exported class
// type while still being type-safe about what we call.
interface RuleCapablePrinter {
  underline(enabled: boolean): void;
  underlineThick(enabled: boolean): void;
  invert(enabled: boolean): void;
  println(text: string): void;
}

/**
 * Thin solid rule — a continuous hairline across the paper.
 * Underline mode over a row of spaces.
 */
export function solidLine(printer: RuleCapablePrinter, width = RECEIPT_WIDTH): void {
  printer.underline(true);
  printer.println(' '.repeat(width));
  printer.underline(false);
}

/**
 * Heavy solid rule — a thicker continuous line.
 */
export function solidLineThick(printer: RuleCapablePrinter, width = RECEIPT_WIDTH): void {
  printer.underlineThick(true);
  printer.println(' '.repeat(width));
  printer.underlineThick(false);
}

/**
 * Solid black bar — inverted (white-on-black) spaces fill the row completely.
 * Use for strong section breaks, e.g. above the grand total.
 */
export function solidBar(printer: RuleCapablePrinter, width = RECEIPT_WIDTH): void {
  printer.invert(true);
  printer.println(' '.repeat(width));
  printer.invert(false);
}


function formatKeyValue(key: string, value: string, padded:boolean = false): string {
  const maxKeyWidth = 15;
  const maxKeyValue = !padded ? 1 : maxKeyWidth - key.length;
  const padding = Math.max(0, maxKeyValue);
  return key + ' '.repeat(padding) + ': ' + value;
}
