import { execFile } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { config } from './config';
import type { FoodOrder, PrinterInfo } from '../shared/types';

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

// ---- Receipt formatting (80mm thermal, plain text) -----------------------

export function formatReceipt(order: FoodOrder): string {
  const line = '------------------------------';
  const rows: string[] = [];
  rows.push('       FOOD ORDER');
  rows.push(line);
  rows.push(`Order #: ${order.orderNumber}`);
  rows.push(`ID     : ${order.orderId}`);
  rows.push(`Time   : ${new Date(order.createdAt).toLocaleString()}`);
  rows.push(`Type   : ${order.orderType.toUpperCase()}`);
  rows.push(line);
  rows.push(`Customer: ${order.customerName}`);
  if (order.customerPhone) rows.push(`Phone   : ${order.customerPhone}`);
  if (order.deliveryAddress) rows.push(`Address : ${order.deliveryAddress}`);
  rows.push(line);
  for (const item of order.items) {
    rows.push(`${item.quantity} x ${item.name}`);
    if (item.specialInstructions) rows.push(`    - ${item.specialInstructions}`);
  }
  rows.push(line);
  rows.push(`Subtotal: ${order.subtotal.toFixed(2)}`);
  rows.push(`Tax     : ${order.tax.toFixed(2)}`);
  rows.push(`TOTAL   : ${order.total.toFixed(2)}`);
  if (order.specialNotes) {
    rows.push(line);
    rows.push(`Notes: ${order.specialNotes}`);
  }
  rows.push(line);
  rows.push('');
  rows.push('');
  return rows.join('\n');
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
