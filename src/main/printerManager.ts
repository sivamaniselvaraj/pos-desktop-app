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

export async function getPrinters(): Promise<PrinterInfo[]> {
  const names = isWindows ? await listPrintersWindows() : await listPrintersUnix();
  const defaultName = config.kitchenPrinter;
  return names.map((name) => ({
    name,
    isDefault: name === defaultName,
    online: true, // OS only lists installed printers; treat listed as available.
  }));
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
  const width = 48;
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
  rows.push('Item' + rightAlign('Qty.', 28) + rightAlign('Price', 10) + rightAlign('Amt', 6));
  rows.push(dashedSeparator);

  // Items
  let totalQty = 0;
  for (const item of order.items) {
    totalQty += item.quantity;
    const qtyStr = String(item.quantity);
    const priceStr = formatCurrency(item.unit_price);
    const amountStr = formatCurrency(item.unit_price * item.quantity);

    const itemLine = item.name;
    if (itemLine.length > 28) {
      rows.push(
        itemLine.substring(0, 28) +
          rightAlign(qtyStr, 5) +
          rightAlign(priceStr, 12) +
          rightAlign(amountStr, 8),
      );
      rows.push(itemLine.substring(28));
    } else {
      rows.push(
        itemLine +
          ' '.repeat(Math.max(0, 28 - itemLine.length)) +
          rightAlign(qtyStr, 5) +
          rightAlign(priceStr, 12) +
          rightAlign(amountStr, 8),
      );
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
  rows.push(center('Powered by PrintPro', width));
  rows.push(separator);
  rows.push('');
  rows.push('');

  return rows.join('\n');
}


// ---- Printing (ESC/POS format) -----------------------------------------------
 
/**
 * Print order using ESC/POS format directly to a thermal printer.
 * Requires a connected USB or network thermal printer.
 */
export async function printOrderEscpos(order: FoodOrder): Promise<void> {
  console.log("printing on pos" , electron)
  const printerName = 'HP_Smart_Tank_580_590_series__8E5406_' //config.kitchenPrinter;
  if (!printerName) {
    throw new Error('No printer configured. Set KITCHEN_PRINTER in .env.local');
  }
 
  try {
    const printer = new ThermalPrinter({
      type: PrinterTypes.EPSON,
      //driver: MyCustomDriver,
      //interface: 'auto', // Device name (e.g., 'COM1', '/dev/usb/lp0', 'USB001')
      //interface:printerName, 
      //interface: 'tcp://192.168.0.111:9100/',
      interface: 'HP_Smart_Tank_580_590_series__8E5406_',
      characterSet: CharacterSet.WPC1252,
      lineCharacter: '─',
      width: 48,
      //driver: require(electron ? 'electron-printer' : 'printer')
    });

    const isConnected = await printer.isPrinterConnected();

    console.log("is connected? ", isConnected)
    
    //console.log("printer status. ",  printer.getStatus())

    const raw = await printer.raw(Buffer.from("Hello world"));
 
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
    printer.drawLine();
 
    printer.alignLeft();
    printer.println(`Name: ${order.customerName}`);
    printer.println('');
 
    const dateTime = new Date(order.createdAt).toLocaleString('en-IN');
    printer.println(formatKeyValue('Date', dateTime));
    printer.println(formatKeyValue('Bill No.', String(order.orderNumber)));
    printer.println(formatKeyValue('Type', order.orderType.toUpperCase()));
 
    if (order.customerPhone) printer.println(formatKeyValue('Phone', order.customerPhone));
    if (order.deliveryAddress) printer.println(formatKeyValue('Address', order.deliveryAddress));
    printer.println('');
    printer.drawLine();
 
    printer.bold(true);
    printer.println('Item' + padRight('Qty.', 10) + padRight('Price', 12) + 'Amt');
    printer.bold(false);
    printer.drawLine();
 
    let totalQty = 0;
    for (const item of order.items) {
      totalQty += item.quantity;
      const qtyStr = String(item.quantity);
      const priceStr = formatCurrency(item.unit_price);
      const amountStr = formatCurrency(item.unit_price * item.quantity);
 
      let itemName = item.name;
      if (itemName.length > 20) {
        printer.println(itemName.substring(0, 20));
        itemName = itemName.substring(20);
      }
 
      const line =
        padRight(itemName, 20) +
        padRight(qtyStr, 6) +
        padRight(priceStr, 12) +
        padLeft(amountStr, 10);
      printer.println(line);
 
      if (itemName.length > 20) {
        printer.println(itemName.substring(0, 20));
      }
 
      if (item.specialInstructions) {
        printer.println('  * ' + item.specialInstructions);
      }
    }
 
    printer.drawLine();
 
    printer.alignLeft();
    printer.println(formatKeyValue('Total Qty', String(totalQty)));
    printer.println(formatKeyValue('Subtotal', formatCurrency(order.subtotal)));
    printer.println('');
    printer.println(formatKeyValue('Tax (GST)', formatCurrency(order.tax)));
 
    if (order.discount && order.discount > 0) {
      printer.println(formatKeyValue('Discount', '-' + formatCurrency(order.discount)));
    }
 
    printer.drawLine();
 
    printer.bold(true);
    printer.setTextSize(1, 1);
    printer.alignCenter();
    printer.println('TOTAL ' + formatCurrency(order.total));
    printer.bold(false);
    printer.setTextSize(0, 0);
    printer.drawLine();
 
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
    printer.println('Thank you! Please visit again.');
    printer.println('Powered by PrintPro');
    printer.drawLine();
    printer.println('');
    printer.println('');

    console.log("printer content ", printer)
 
    await printer.execute();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to print with ESC/POS';
    throw new Error(message);
  }
}
 
// Helper functions
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
