import { execFile } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { config } from './config';
import type { FoodOrder, PrinterInfo } from '../shared/types';
import { CharacterSet, PrinterTypes, ThermalPrinter, printer } from 'node-thermal-printer';

const electron = typeof process !== 'undefined' && process.versions && !!process.versions.electron;

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

// ---- OS spooler driver ---------------------------------------------------
// node-thermal-printer's `printer:Name` interface needs a native driver
// injected via the `driver` option; the library ships none (that's the
// "No driver set!" error). We use @grandchef/node-printer, the maintained
// fork. It's a native addon compiled per-platform/Electron ABI, so it may be
// absent or unbuilt in some environments — load it lazily and fail with a
// clear, actionable message rather than crashing at startup.
let cachedDriver: object | null = null;
 
function loadSpoolerDriver(): object {
  if (cachedDriver) return cachedDriver;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const driver = require('@grandchef/node-printer') as object;
    cachedDriver = driver;
    return driver;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      'Printer driver (@grandchef/node-printer) could not be loaded. Ensure it is installed and rebuilt for Electron: ' +
        'npm install @grandchef/node-printer && npx electron-rebuild -f -w @grandchef/node-printer. ' +
        `Details: ${detail}`,
    );
  }
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

export async function getPrinters(): Promise<PrinterInfo[]> {
  const names = isWindows ? await listPrintersWindows() : await listPrintersUnix();
  const defaultName = config.kitchenPrinter;
  return names
    .filter((name) => !isVirtualPrinter(name))
    .map((name) => ({
      name,
      isDefault: name === defaultName,
      online: true, // OS only lists installed printers; treat listed as available.
    }));
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

/**
 * Print a line, emitting any '₹' via the configured RUPEE_MODE rather than
 * letting iconv mangle it to '?'. Column maths are unaffected: '₹' counts as
 * one character in the padded string and prints as ~one character width.
 */
function line(printer: RawPrinter & { newLine(): void }, text: string): void {
  if (RUPEE_MODE === 'text' || !text.includes('₹')) {
    printer.append(text.replace(/₹/g, 'Rs.'));
    printer.newLine();
    return;
  }

  if (RUPEE_MODE === 'byte' && RUPEE_BYTE === null) {
    // byte mode requested but not configured — degrade to "Rs." safely.
    printer.append(text.replace(/₹/g, 'Rs.'));
    printer.newLine();
    return;
  }

  const parts = text.split('₹');
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      if (RUPEE_MODE === 'image') {
        emitRupeeImage(printer);
      } else {
        if (RUPEE_CODEPAGE !== null) selectCodePage(printer, RUPEE_CODEPAGE);
        raw(printer, [RUPEE_BYTE as number]);
      }
    }
    if (parts[i]) printer.append(parts[i]);
  }
  printer.newLine();
}



// ---- Receipt layout --------------------------------------------------------
// Column widths must sum to exactly RECEIPT_WIDTH (48) or rows overflow and
// the printer hard-wraps them, breaking alignment.
const RECEIPT_WIDTH = 48;
const ITEM_COL = 20; // left
const QTY_COL = 4; // right
const PRICE_COL = 12; // right
const AMT_COL = 12; // right
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

// ---- Receipt formatting (80mm thermal, 48-char width) -----------------------

function center(text: string, width: number): string {
  const padding = Math.max(0, width - text.length);
  const left = Math.floor(padding / 2);
  const right = padding - left;
  return ' '.repeat(left) + text + ' '.repeat(right);
}

function rightAlign(text: string, width: number): string {
  const padding = Math.max(0, width - text.length);
  return ' '.repeat(padding) + text;
}

function formatCurrency(amount: number): string {
  return `₹ ${amount.toFixed(2)}`;
}

export function formatReceipt(order: FoodOrder): string {
  const width = RECEIPT_WIDTH;
  const separator = '='.repeat(width);
  const dashedSeparator = '-'.repeat(width);
  const rows: string[] = [];

  // Header — use actual outlet info or fallback
  const outletName = order.outlet?.name ?? 'FOOD ORDER PRINTER';
  const outletAddress = order.outlet?.address ?? 'Address not available';
  const outletPhone = order.outlet?.phone ?? '';
  const outletCity = order.outlet?.city ?? '';
  const outletGST = order.outlet?.gstNumber ?? '';

  rows.push(separator);
  rows.push(center(outletName, width));
  rows.push(center(outletAddress, width));
  const headerLine =
    (outletCity ? outletCity + ' | ' : '') +
    (outletPhone ? outletPhone : '') +
    (outletGST ? ' | ' + outletGST : '');
  if (headerLine.trim()) rows.push(center(headerLine, width));
  rows.push(separator);
  rows.push('');

  // Order meta
  const dateTime = new Date(order.createdAt).toLocaleString('en-IN');
  rows.push(`Name: ${order.customerName}`);
  rows.push('');

  // Date and order type on same line
  const dateCol = dateTime.substring(0, 20);
  const typeStr = `${order.orderType.toUpperCase()}`;
  rows.push(dateCol + rightAlign(typeStr, width - dateCol.length));

  rows.push(`Bill No.: ${order.orderNumber}`);
  if (order.customerPhone) rows.push(`Phone: ${order.customerPhone}`);
  if (order.deliveryAddress) rows.push(`Address: ${order.deliveryAddress}`);
  rows.push('');

  // Item table header
  
    rows.push(
    padRight('Item', ITEM_COL) +
      rightAlign('Qty', QTY_COL) +
      rightAlign('Price', PRICE_COL) +
      rightAlign('Amount', AMT_COL),
  );

  rows.push(dashedSeparator);

  // Items
  let totalQty = 0;
  for (const item of order.items) {
    totalQty += item.quantity;
    const qtyStr = String(item.quantity);
    const priceStr = formatCurrency(item.unit_price);
    const amountStr = formatCurrency(item.unit_price * item.quantity);

       // First line carries the numeric columns; any remaining name lines are
    // indented continuations. (Previously the remainder was re-tested after
    // being reassigned, so names longer than 2 columns were dropped.)
    const nameLines = wrapText(item.name, ITEM_COL);

      rows.push(
      padRight(nameLines[0], ITEM_COL) +
        rightAlign(qtyStr, QTY_COL) +
        rightAlign(priceStr, PRICE_COL) +
        rightAlign(amountStr, AMT_COL),
    );
    for (const cont of nameLines.slice(1)) {
      rows.push('  ' + cont);
    }


    if (item.specialInstructions) {
      rows.push('  * ' + item.specialInstructions);
    }
  }

  rows.push(dashedSeparator);

  // Totals section
  const totalQtyStr = `Total Qty: ${totalQty}`;
  const subtotalStr = formatCurrency(order.subtotal);
  rows.push(totalQtyStr + rightAlign('Subtotal: ' + subtotalStr, width - totalQtyStr.length));
  rows.push('');

  rows.push(rightAlign('Tax (GST): ' + formatCurrency(order.tax), width));

  if (order.discount && order.discount > 0) {
    rows.push(rightAlign('Discount: -' + formatCurrency(order.discount), width));
  }

  rows.push(dashedSeparator);

  const totalLine = 'TOTAL ' + formatCurrency(order.total);
  rows.push(center(totalLine, width));
  rows.push(separator);
  rows.push('');

  if (order.specialNotes) {
    rows.push(center('Special Notes', width));
    rows.push(order.specialNotes);
    rows.push('');
  }

  rows.push(center('Thank you! Please visit again.', width));
  rows.push(separator);
  return rows.join('\n');
}

// ---- Printing (ESC/POS format) -----------------------------------------------
 
/**
 * Print order using ESC/POS format directly to a thermal printer.
 * Requires a connected USB or network thermal printer.
 */
export async function printOrderEscpos(order: FoodOrder, printerName:string): Promise<void> {
  console.log("printing for the order" , order.id)

  // Validate printer is configured
  if (!printerName || printerName.trim() === '') {
    throw new Error('No printer configured. Set KITCHEN_PRINTER in .env.local');
  }

  try {

     // Print through the OS spooler. node-thermal-printer's `printer:Name`
    // interface hands the raw ESC/POS buffer to the injected driver, which
    // submits it to the Windows spooler / CUPS as a RAW job. The printer must
    // be installed in the OS as a RAW/generic-text device so bytes pass
    // through untouched. `Name` must match the OS printer name exactly
    // (Get-Printer on Windows, lpstat -p on macOS/Linux).
    const driver = loadSpoolerDriver();
    const printer = new ThermalPrinter({
      type: PrinterTypes.CUSTOM,
      interface: 'printer:' + printerName,
      driver: require(electron ? '@grandchef/node-printer' : 'printer') as object,
      characterSet: CharacterSet.WPC1252,
      lineCharacter: '-', // must be single-byte ASCII: drawLine() does no codepage conversion
      width: RECEIPT_WIDTH,
    });
    const isConnected = await printer.isPrinterConnected();

     if (!isConnected) {
      throw new Error(
        `Printer "${printerName}" was not found or is unavailable. Check it is installed in the OS (Get-Printer / lpstat -p) and the name matches exactly.`,
      );
    }
     // Build receipt
    printer.alignCenter();
    printer.setTextSize(1, 1);
    printer.bold(true);
    printer.println(order.outlet?.name ?? 'FOOD ORDER PRINTER');
    printer.bold(false);

    if (order.outlet?.address) {
      printer.setTextSize(0, 0);
      printer.println(order.outlet.address);
    }

    if (order.outlet?.city || order.outlet?.phone || order.outlet?.gstNumber) {
      const headerLine = [order.outlet?.city, order.outlet?.phone, order.outlet?.gstNumber]
        .filter(Boolean)
        .join(' | ');
      if (headerLine) {
        printer.setTextSize(0, 0);
        printer.println(headerLine);
      }
    }

    printer.setTextSize(0, 0);
    solidLine(printer);
    printer.drawLine(); 

    printer.alignLeft();
    printer.println(`Name: ${order.customerName}`);
    solidLine(printer);
    //printer.println('');

    const dateTime = new Date(order.createdAt).toLocaleString('en-IN');
    printer.println(formatKeyValue('Date', dateTime));
    printer.println(formatKeyValue('Bill No.', String(order.orderNumber)));
    printer.println(formatKeyValue('Type', order.orderType.toUpperCase()));
     printer.println(formatKeyValue('Token No.', String(order.tokenNumber)));

    if (order.customerPhone) printer.println(formatKeyValue('Phone', order.customerPhone));
    if (order.deliveryAddress) printer.println(formatKeyValue('Address', order.deliveryAddress));

    solidLine(printer);

    printer.bold(true);
    printer.println(
      padRight('Item', ITEM_COL) +
        rightAlign('Qty', QTY_COL) +
        rightAlign('Price', PRICE_COL) +
        rightAlign('Amount', AMT_COL),
    );
    printer.bold(false);
    solidLine(printer);

    let totalQty = 0;
    for (const item of order.items) {
      totalQty += item.quantity;
      const qtyStr = String(item.quantity);
      const priceStr = formatCurrency(item.unit_price);
      const amountStr = formatCurrency(item.unit_price * item.quantity);

      // First line carries the numeric columns; remaining name lines are
      // indented continuations.
      const nameLines = wrapText(item.name, ITEM_COL);
      line(
        printer,
        padRight(nameLines[0], ITEM_COL) +
          rightAlign(qtyStr, QTY_COL) +
          rightAlign(priceStr, PRICE_COL) +
          rightAlign(amountStr, AMT_COL),
      );
      for (const cont of nameLines.slice(1)) {
        printer.println('  ' + cont);
      }

      if (item.specialInstructions) {
        printer.println('  * ' + item.specialInstructions);
      }
    }

    solidLine(printer);


    printer.tableCustom([                                       // Prints table with custom settings (text, align, width, cols, bold)
      { text:"Item", align:"LEFT", cols:ITEM_COL, bold:true },
      { text:"Qty", align:"CENTER", cols:QTY_COL, bold:true },
      { text:"Price", align:"RIGHT", cols:PRICE_COL , bold:true},
      { text:"Amount", align:"RIGHT", cols:AMT_COL , bold:true}
    ]);

    printer.alignRight();
    printer.println(formatKeyValue('Total Qty', String(totalQty)));
    line(printer, formatKeyValue('Subtotal', formatCurrency(order.subtotal)));
    printer.println('');
    line(printer, formatKeyValue('Tax (GST)', formatCurrency(order.tax)));

    if (order.discount && order.discount > 0) {
      line(printer, formatKeyValue('Discount', '-' + formatCurrency(order.discount)));
    }

    solidLineThick(printer);

    printer.bold(true);
    printer.setTextSize(1, 1);
    printer.alignRight();
    line(printer, 'Grand Total ' + formatCurrency(order.total));
    printer.bold(false);
    printer.setTextSize(0, 0);
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
    printer.bold(true);
    printer.println('Thank you! Please visit again.');
    printer.bold(false);
    //printer.setTextSize(0, 0);
    solidLine(printer);
    printer.cut();

    await printer.execute();
 
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to print with ESC/POS';
    throw new Error(message);
  }
}
 
// Helper functions

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


function formatKeyValue(key: string, value: string): string {
  const maxKeyWidth = 15;
  const padding = Math.max(0, maxKeyWidth - key.length);
  return key + ' '.repeat(padding) + ': ' + value;
}
 
function padRight(text: string, width: number): string {
  const padding = Math.max(0, width - text.length);
  return text + ' '.repeat(padding);
}
 
function padLeft(text: string, width: number): string {
  const padding = Math.max(0, width - text.length);
  return ' '.repeat(padding) + text;
}


// ---- Printing ------------------------------------------------------------

export async function printOrder(order: FoodOrder): Promise<void> {
  const printerName = config.kitchenPrinter;
  const receipt = formatReceipt(order);
  const tmpFile = join(tmpdir(), `order-${order.orderId}-${randomUUID()}.txt`);
  await writeFile(tmpFile, receipt, 'utf8');

  try {
    if (isWindows) {
      // Print a text file to a named printer via PowerShell.
      const cmd = printerName
        ? `Get-Content -Raw '${tmpFile}' | Out-Printer -Name '${printerName}'`
        : `Get-Content -Raw '${tmpFile}' | Out-Printer`;
      await execFileAsync('powershell', ['-NoProfile', '-Command', cmd]);
    } else {
      // CUPS: lp -d <printer> <file>
      const args = printerName ? ['-d', printerName, tmpFile] : [tmpFile];
      await execFileAsync('lp', args);
    }
  } finally {
    await unlink(tmpFile).catch(() => undefined);
  }
}
