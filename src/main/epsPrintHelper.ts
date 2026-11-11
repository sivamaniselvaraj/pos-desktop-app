import { ThermalPrinter, PrinterTypes, CharacterSet } from 'node-thermal-printer';
import { FoodOrder } from '../shared/types';
import { billFooterLines, billHeaderLines } from './printerManager';
import { taxBillLines } from '../shared/orderTotals';

const electron = typeof process !== 'undefined' && process.versions && !!process.versions.electron;

// ---- Receipt layout --------------------------------------------------------
// Column widths must sum to exactly RECEIPT_WIDTH (48) or rows overflow and
// the printer hard-wraps them, breaking alignment.
const RECEIPT_WIDTH = 48;
const ITEM_COL = 20; // left
const QTY_COL = 4; // right
const PRICE_COL = 12; // right
const AMT_COL = 12; // right
const INFO_COL = RECEIPT_WIDTH - AMT_COL;
// 22 + 4 + 12 + 12 = 48

// ---- OS spooler driver ---------------------------------------------------
// node-thermal-printer's `printer:Name` interface needs a native driver
// injected via the `driver` option; the library ships none (that's the
// "No driver set!" error). We use @timokunze/node-printer, the maintained
// fork. It's a native addon compiled per-platform/Electron ABI, so it may be
// absent or unbuilt in some environments — load it lazily and fail with a
// clear, actionable message rather than crashing at startup.

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

function formatCurrency(amount: number): string {
  return `₹ ${amount.toFixed(2)}`;
}

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

export async function printBillEscPos(
  order: FoodOrder,
  printerName: string,
  isDuplicate = false,
): Promise<void> {
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
    printer.alignCenter();
    printer.setTextSize(1, 1);
    printer.bold(true);
    printer.println(order.outlet?.businessName || order.outlet?.name || 'RESTAURANT PRINTER');
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

    if (order.customerName.trim() !== '' && order.customerName !== 'Unknown') {
      printer.alignLeft();
      printer.println(`Name: ${order.customerName}`);
      solidLineThick(printer);
    }
    //printer.println('');

    const dateTime = new Date(order.createdAt).toLocaleString('en-IN', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    // printer.println(formatKeyValue('Date', dateTime));
    // printer.println(formatKeyValue('Bill No.', String(order.orderNumber)));
    // printer.println(formatKeyValue('Type', order.orderType.toUpperCase()));
    // printer.println(formatKeyValue('Token No.', String(order.tokenNumber)));

    const orderType =
      order.orderType === 'pickup' || order.orderType === 'takeaway' ? 'Pick Up' : 'Dine In';

    printer.tableCustom([
      // Prints table with custom settings (text, align, width, cols, bold)
      { text: formatKeyValue('Date', dateTime), align: 'LEFT' },
      { text: orderType.toUpperCase(), align: 'LEFT', bold: true },
    ]);
    printer.tableCustom([
      // Prints table with custom settings (text, align, width, cols, bold)
      { text: '', align: 'LEFT' },
      { text: formatKeyValue('Bill No.', String(order.orderNumbers)), align: 'LEFT', bold: true },
    ]);
    if (orderType === 'Pick Up') {
      printer.tableCustom([
        // Prints table with custom settings (text, align, width, cols, bold)
        {
          text: formatKeyValue('Token No.', String(order.orderNumbers)),
          align: 'LEFT',
          bold: true,
        },
        { text: '', align: 'LEFT' },
      ]);
    }

    if (order.customerPhone) printer.println(formatKeyValue('Phone', order.customerPhone));
    if (order.deliveryAddress) printer.println(formatKeyValue('Address', order.deliveryAddress));

    solidLine(printer);

    let totalQty = 0;

    printer.tableCustom([
      // Prints table with custom settings (text, align, width, cols, bold)
      { text: 'Item', align: 'LEFT', cols: ITEM_COL, bold: true },
      { text: 'Qty', align: 'CENTER', cols: QTY_COL, bold: true },
      { text: 'Price', align: 'RIGHT', cols: PRICE_COL, bold: true },
      { text: 'Amount', align: 'RIGHT', cols: AMT_COL, bold: true },
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
      printer.tableCustom([
        // Prints table with custom settings (text, align, width, cols, bold)
        { text: nameLines[0], align: 'LEFT', cols: ITEM_COL, bold: false },
        { text: qtyStr, align: 'CENTER', cols: QTY_COL, bold: false },
        { text: priceStr, align: 'RIGHT', cols: PRICE_COL, bold: false },
        { text: amountStr, align: 'RIGHT', cols: AMT_COL, bold: false },
      ]);
    }
    solidLine(printer);
    printer.tableCustom([
      { text: 'Total Qty', align: 'RIGHT', cols: INFO_COL, bold: false },
      { text: String(totalQty), align: 'RIGHT', cols: AMT_COL, bold: false },
    ]);
    printer.tableCustom([
      { text: 'Sub Total', align: 'RIGHT', cols: INFO_COL, bold: true },
      { text: formatCurrency(order.subtotal), align: 'RIGHT', cols: AMT_COL, bold: true },
    ]);
    if (orderType === 'Pick Up' && order.containerCharge && order.containerCharge > 0) {
      printer.tableCustom([
        { text: 'Container Charge', align: 'RIGHT', cols: INFO_COL, bold: true },
        {
          text: formatCurrency(order.containerCharge ?? 0),
          align: 'RIGHT',
          cols: AMT_COL,
          bold: true,
        },
      ]);
    }

    for (const t of taxBillLines(order.taxBreakdown, order.tax)) {
      printer.tableCustom([
        { text: t.label, align: 'RIGHT', cols: INFO_COL, bold: true },
        { text: formatCurrency(t.amount), align: 'RIGHT', cols: AMT_COL, bold: true },
      ]);
    }

    if (order.discount && order.discount > 0) {
      printer.tableCustom([
        // Prints table with custom settings (text, align, width, cols, bold)
        { text: 'Discount', align: 'RIGHT', cols: INFO_COL, bold: true },
        { text: formatCurrency(order.discount), align: 'RIGHT', cols: AMT_COL, bold: true },
      ]);
      //line(printer, formatKeyValue('Discount', '-' + formatCurrency(order.discount)));
    }

    solidLineThick(printer);

    let grandTotal = Number.parseInt(order?.total.toString());
    let roundOff = (grandTotal - order.total).toFixed(2);

    printer.tableCustom([
      // Prints table with custom settings (text, align, width, cols, bold)
      { text: 'Round off', align: 'RIGHT', cols: INFO_COL, bold: false },
      { text: roundOff, align: 'RIGHT', cols: AMT_COL, bold: false },
    ]);
    printer.tableCustom([
      // Prints table with custom settings (text, align, width, cols, bold)
      { text: 'Grand Total', align: 'RIGHT', cols: INFO_COL, bold: true },
      { text: formatCurrency(grandTotal), align: 'RIGHT', cols: AMT_COL, bold: true },
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

/** Print a KOT as ESC/POS. `name` is the trimmed, non-empty printer name. */
export async function printKotEscPos(order: FoodOrder, printerName: string): Promise<void> {
  let isPickup = order.orderType === 'pickup' || order.orderType === 'takeaway';
  let kotTitle = isPickup ? 'TAKEAWAY' : 'WAITER KOT';
  let orderType = isPickup ? 'Pick Up' : 'Dine In';

  const tableLabel =
    order.tableNumber != null && String(order.tableNumber).trim() !== ''
      ? String(order.tableNumber)
      : '-';

  try {
    const printer = loadPrinterDriver(printerName);
    const connected = await printer.isPrinterConnected();
    if (!connected) {
      throw new Error(
        `Printer "${printerName}" was not found or is unavailable. Check it is installed in the OS and the name matches exactly.`,
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
    if (order.orderNumber) {
      printer.println('KOT - ' + order.orderNumber);
    }

    printer.bold(true);
    printer.println(orderType);
    if (!isPickup) {
      printer.setTextSize(1, 1);
      printer.println(`Table No: ${tableLabel}`);
    }
    printer.setTextSize(0, 0);
    printer.bold(false);
    solidLine(printer);
    printer.println(order.placedBy ? order.placedBy : 'Biller');
    solidLine(printer);

    // Items — quantity emphasised, no prices on a KOT.
    let totalQty = 0;
    const ITEM_COL = RECEIPT_WIDTH - QTY_COL;
    printer.tableCustom([
      // Prints table with custom settings (text, align, width, cols, bold)
      { text: 'Item', align: 'LEFT', cols: ITEM_COL, bold: true },
      { text: 'Qty', align: 'CENTER', cols: QTY_COL, bold: true },
    ]);

    for (const item of order.items) {
      totalQty += item.quantity;
      const qtyStr = String(item.quantity);
      const nameLines = wrapText(item.name, RECEIPT_WIDTH - 5);
      printer.tableCustom([
        // Prints table with custom settings (text, align, width, cols, bold)
        { text: nameLines[0], align: 'LEFT', cols: ITEM_COL, bold: false },
        { text: qtyStr, align: 'CENTER', cols: QTY_COL, bold: false },
      ]);
      if (item.specialInstructions) {
        printer.println('     * ' + item.specialInstructions);
      }
    }

    solidLine(printer);

    printer.tableCustom([
      // Prints table with custom settings (text, align, width, cols, bold)
      { text: '', align: 'LEFT', cols: ITEM_COL, bold: true },
      { text: String(totalQty), align: 'CENTER', cols: QTY_COL, bold: true },
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
        message = `Print driver not initialized for "${printerName}". The @timokunze/node-printer module is missing or not rebuilt for Electron.`;
      } else if (/not found|unavailable|NOT-AVAILABLE/i.test(message)) {
        message = `Printer "${printerName}" not found in the OS spooler. Verify the name matches Get-Printer / lpstat -p exactly and the printer is online.`;
      }
    }
    throw new Error(message);
  }
}

/** Print the test slip as ESC/POS. `name` is the trimmed, non-empty printer name. */
export async function testPrintEscPos(name: string): Promise<string> {
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

function formatKeyValue(key: string, value: string): string {
  const maxKeyWidth = 15;
  const padding = Math.max(0, maxKeyWidth - key.length);
  return key + ' '.repeat(padding) + ': ' + value;
}

function padRight(text: string, width: number): string {
  const padding = Math.max(0, width - text.length);
  return text + ' '.repeat(padding);
}
