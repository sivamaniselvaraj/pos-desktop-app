import { app, BrowserWindow } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';
import { taxBillLines } from '../shared/orderTotals';
import { DINE_IN_ORDER_TYPE, PICK_UP_ORDER_TYPE, type FoodOrder } from '../shared/types';
import { billFooterLines, billHeaderLines, getPrinters, parseHeaderConfig } from './printerManager';
import { PrintTimeoutError, withTimeout } from './printQueueManager';

/**
 * htmlPrint.ts
 * ---------------------------------------------------------------------------
 * HTML print path for the bill and the KOT (80 mm thermal roll, 72 mm printed width). The layouts
 * mirror the ESC/POS ones in printerManager.ts; printing is silent (no dialog)
 * to the printer already mapped in Settings, through the OS driver.
 *
 * Differences from the direct (ESC/POS) path: no printer cut / cash-drawer
 * commands (the printer driver's own "cut at end of document" setting applies)
 * and the page height is measured from the content so a roll is not wasted.
 * ---------------------------------------------------------------------------
 */

// Page width sent to the driver. 80 mm thermal printers print 72 mm wide, and
// their Windows drivers offer paper such as "72 x 3276 mm" (RP3150 STAR). An
// 80 mm page did not match it and came out as a blank strip (2026-11-05).
//const PAPER_MM = 80;
export const PAPER_MM = 72;
// Longest page these drivers accept (72 x 3276 mm).
const MAX_PAGE_MICRONS = 3276 * 1000;
const PX_TO_MICRONS = 25400 / 96;

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const money = (n: number) => `₹ ${Number(n).toFixed(2)}`;
const price = (n: number) => `${Number(n).toFixed(2)}`;

const CSS = `
  @page { size: ${PAPER_MM}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { width: ${PAPER_MM}mm; padding: 2mm 2mm 4mm; font-family: Arial, 'Segoe UI', sans-serif;
         font-size: 12px; line-height: 1.35; color: #000; }
  .c { text-align: center; } .r { text-align: right; } .b { font-weight: 700; }
  .lg { font-size: 20px; font-weight: 800; } .xl { font-size: 24px; font-weight: 800; }
  .rule { border-top: 1px solid #000; margin: 5px 0; }
  .thick { border-top: 2px solid #000; margin: 5px 0; }
  .inv { display: inline-block; background: #000; color: #fff; padding: 1px 8px; font-weight: 700; }
  .kv { display: flex; gap: 6px; } .kv .k { width: 26mm; flex: none; } .kv .v { flex: 1; word-break: break-word; }
  .kv .k::after { content: ' :'; }
  .sub { display: flex; justify-content: space-between; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-weight: 700; padding: 1px 0; }
  td { vertical-align: top; padding: 1px 0; }
  th.n, td.n { text-align: right; white-space: nowrap; padding-left: 4px; }
  .note { padding-left: 8px; font-style: italic; }
  .kotq { width: 11mm; font-weight: 800; font-size: 15px; }
  .kotn { font-size: 14px; font-weight: 700; }
  .gTotal { font-size: 16px; font-weight: 700; }
`;

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${body}</body></html>`;
}

function kv(k: string, v: string): string {
  return `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
}

export function renderBillHtml(order: FoodOrder, isDuplicate = false): string {
  const header = parseHeaderConfig(order.headerConfig);
  const out: string[] = [];

  out.push(
    `<div class="c lg">${esc(header?.restaurantName?.trim() || order.outlet?.businessName || order.outlet?.name || 'RESTAURANT PRINTER')}</div>`,
  );
  for (const l of billHeaderLines(order)) out.push(`<div class="c">${esc(l)}</div>`);
  out.push('<div class="rule"></div>');

  if (isDuplicate) {
    out.push('<div class="c"><span class="inv">DUPLICATE BILL</span></div><div class="rule"></div>');
  }

  out.push(`<div>Name: ${esc(order.customerName)}</div>`);
  out.push('<div style="height:4px"></div>');
  out.push(
    `<table>` +
      `<tbody>
        <tr>
          <td>${new Date(order.createdAt).toLocaleString('en-IN')}</td>
          <td>${(order.orderType === 'takeaway' ? 'pick up' : 'dine in').toUpperCase()}</td>
        </tr>
        <tr>
          <td>cashier: ${order.placedBy}</td>
          <td>Bill No. ${order.invoiceNumber?.slice(-5)}</td>
        </tr>
        <tr>
          <td>Token No. ${order.orderNumbers && order.orderNumbers.length > 0 ? order.orderNumbers.join(', ') : String(order.orderNumber)}</td>
          <td></td>
        </tr>
      </tbody>
      </table>`
  );


  if (order.customerPhone) out.push(kv('Phone', order.customerPhone));
  if (order.deliveryAddress) out.push(kv('Address', order.deliveryAddress));
  out.push('<div class="rule"></div>');

  let totalQty = 0;
  const rows = order.items
    .map((item) => {
      totalQty += item.quantity;
      const note = item.specialInstructions ? `<tr><td colspan="4" class="note">* ${esc(item.specialInstructions)}</td></tr>` : '';
      return (
        `<tr><td>${esc(item.name)}</td><td class="n">${item.quantity}</td>` +
        `<td class="n">${price(item.unitPrice)}</td><td class="n">${price(item.unitPrice * item.quantity)}</td></tr>${note}`
      );
    })
    .join('');
  out.push(
    `<table><thead><tr><th>Item</th><th class="n">Qty.</th><th class="n">Price</th><th class="n">Amount</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`,
  );
  out.push('<div class="rule"></div>');

  const line = (k: string, v: string) => `<tr class="sub"><td class="r" style="width:65%">${esc(k)}</td><td class="r" style="width:35%">${esc(v)}</td></tr>`;
  let grandTotal = Number.parseInt(order?.total.toString());
  let roundOff = (grandTotal - order.total);
  out.push("<table>");
  out.push(line('Total Qty', String(totalQty)));
  out.push(line('Subtotal', price(order.subtotal)));
  if (order.containerCharge && order.containerCharge > 0) out.push(line('Container Charge', price(order.containerCharge)));
  if (order.discount && order.discount > 0) {
    out.push(line(order.isComplimentary ? 'Complimentary' : 'Discount', '-' + price(order.discount)));
  }
  for (const t of taxBillLines(order.taxBreakdown, order.tax)) out.push(line(t.label, price(t.amount)));
  out.push("</table>");
  out.push('<div class="rule"></div>');
  out.push("<table>");
  if (roundOff * 100 < 0) {
    out.push(`<tr><td class="r" style="width:60%">Round off</td><td class="r" style="width:40%">${esc(price(roundOff))}</td></tr>`);
  };
  out.push(`<tr class="gTotal"><td class="r" style="width:60%">Grand Total</td><td class="r" style="width:40%">${esc(money(grandTotal))}</td></tr>`);
  out.push("</table>");
  if (order.specialNotes) {
    out.push('<div class="thick"></div>');
    out.push(`<div class="c b">Special Notes</div><div>${esc(order.specialNotes)}</div><div style="height:4px"></div>`);
  }
  const footer = billFooterLines(order);
  out.push('<div class="rule"></div>');
  for (const f of footer) {
    out.push(`<div class="c">${esc(f)}</div>`)
  };
  return page(out.join(''));
}

export function renderKotHtml(order: FoodOrder): string {
  const out: string[] = [];
  const title = order.orderType === 'pickup' || order.orderType === PICK_UP_ORDER_TYPE ? 'TAKEAWAY KOT' : 'WAITER KOT';
  out.push(`<div class="c lg">${title}</div>`);
  if (order.orderType !== PICK_UP_ORDER_TYPE && order.isRunningOrder) out.push('<div class="c b">** RUNNING ORDER **</div>');

  out.push(`<div class="c">${new Date(order.createdAt).toLocaleString('en-IN')}</div>`);
  out.push(`<div class="c b">KOT - ${String(order.orderNumber)}</div>`);
  
  if (order.orderType === DINE_IN_ORDER_TYPE){
    const table =
      order.tableNumber != null && String(order.tableNumber).trim() !== '' ? String(order.tableNumber) : '-';
    out.push(`<div class="c xl">Table No: ${esc(table)}</div>`);
  }
  
  out.push(`<div class="c">${order.orderType.toUpperCase()}</div>`);

  out.push('<div class="rule"></div>');
  if (order.placedBy) out.push(`<div class="c">${(order.placedBy)}</div>`);
  out.push('<div class="rule"></div>');

  let totalQty = 0;
  const rows = order.items
    .map((item) => {
      totalQty += item.quantity;
      const note = item.specialInstructions
        ? `<div class="note">* ${esc(item.specialInstructions)}</div>`
        : '';
      return `<tr><td class="kotn">${item.name}</td><td class="kotq">${esc(item.quantity)}${note}</td></tr>`;
    })
    .join('');
  out.push(`<table><thead><tr><th>Item</th><th>Qty</th></tr></thead><tbody>${rows}</tbody></table>`);
  out.push('<div class="rule"></div>');
  out.push(`<table><tbody><td></td><td class="kotq">${totalQty}</td></tbody></table>`);
  if (order.specialNotes) {
    out.push(`<div class="rule"></div><div class="b">Notes:</div><div>${esc(order.specialNotes)}</div>`);
  }
  return page(out.join(''));
}

export function renderTestHtml(printerName: string, method = 'HTML (Electron)'): string {
  return page(
    `<div class="c lg">TEST PRINT</div><div class="rule"></div>` +
      kv('Printer', printerName) +
      kv('Time', new Date().toLocaleString('en-IN')) +
      kv('Method', method) +
      `<div class="c">தமிழ் · ₹ 123.45</div>` +
      `<div class="rule"></div><div class="c">If you can read this,</div><div class="c">printing works.</div>`,
  );
}

// One hidden window prints every HTML job, one job at a time.
//
// The window is created on the first job and kept for the life of the app
// (before, every job built and destroyed its own BrowserWindow, which is slow
// on a busy service). Jobs must still run strictly one after another: the one
// window can hold only one document, and a KOT and a bill fired together to
// the same printer otherwise collide in the driver. Most callers already go
// through the shared printQueue; this small chain also covers the ones that
// do not (Retry and Test print from the UI) and adds the 0.7 s gap.
let chain: Promise<void> = Promise.resolve();
const GAP_MS = 700; // let the driver/spooler finish taking one job before the next starts
// One HTML job (load, measure, print) may take at most this long. Shorter than the
// shared print queue's 45 s limit, so the HTML job fails first with a clear message.
// A job that times out throws the window away (it may be stuck in the driver); the
// next job gets a fresh one.
const HTML_JOB_TIMEOUT_MS = 30_000;

let printWindow: BrowserWindow | null = null;

// Resolves once fonts are loaded and two frames have painted (or after 1 s,
// in case animation frames never fire in the hidden window).
const PAINTED_JS = `Promise.race([
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))),
  new Promise((r) => setTimeout(() => r(false), 1000)),
])`;
const PAINT_SETTLE_MS = 150;

function getPrintWindow(): BrowserWindow {
  if (printWindow && !printWindow.isDestroyed()) return printWindow;
  const win = new BrowserWindow({
    show: false,
    // A hidden window must still paint, or the driver gets a blank page
    // (a blank strip of paper on 2026-11-05).
    paintWhenInitiallyHidden: true,
    width: 400,
    height: 800,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
      backgroundThrottling: false,
    },
  });
  // A crashed renderer cannot print again: drop it so the next job makes a new one.
  win.webContents.on('render-process-gone', () => closeWindow(win));
  win.on('closed', () => {
    if (printWindow === win) printWindow = null;
  });
  printWindow = win;
  return win;
}

/**
 * Close the hidden print window. index.ts calls this when the main window
 * closes, otherwise the hidden window would keep the app running.
 */
export function destroyHtmlPrintWindow(): void {
  const win = printWindow;
  printWindow = null;
  if (win && !win.isDestroyed()) win.destroy();
}

/** True if `name` is an installed OS printer. Uses the 60 s printer cache, re-reading the OS on a miss. */
async function printerExists(name: string): Promise<boolean> {
  if ((await getPrinters()).some((p) => p.name === name)) return true;
  return (await getPrinters(true)).some((p) => p.name === name);
}

/** Print an HTML document silently to a named OS printer (queued, one job at a time). */
export function printHtml(html: string, printerName: string): Promise<void> {
  const job = chain.then(() => printHtmlNow(html, printerName));
  // Keep the chain alive after a failure, and pause between jobs.
  chain = job.then(
    () => new Promise<void>((r) => setTimeout(r, GAP_MS)),
    () => new Promise<void>((r) => setTimeout(r, GAP_MS)),
  );
  return job;
}

async function printHtmlNow(html: string, printerName: string): Promise<void> {
  const name = (printerName ?? '').trim();
  if (!name) throw new Error('No printer selected.');
  if (!(await printerExists(name))) {
    throw new Error(
      `Printer "${name}" was not found in the OS. Check it is installed and the name matches exactly.`,
    );
  }

  try {
    await withTimeout(printWithRetry(html, name), HTML_JOB_TIMEOUT_MS, `HTML print to "${name}"`);
  } catch (err) {
    if (err instanceof PrintTimeoutError) destroyHtmlPrintWindow();
    throw err;
  }
}

/** Raised when the print page cannot be loaded into the hidden window. */
class PageLoadError extends Error {}

// If the page will not load (the reused window can get into a state where every
// load fails at once with ERR_FAILED), throw that window away and try once more
// with a fresh one. Printer errors are not retried: the driver may have printed.
async function printWithRetry(html: string, name: string): Promise<void> {
  let win = getPrintWindow();
  try {
    await renderAndPrint(win, html, name);
  } catch (err) {
    if (!(err instanceof PageLoadError)) throw err;
    console.warn(`[htmlPrint] ${err.message} Retrying with a new print window.`);
    closeWindow(win);
    win = getPrintWindow();
    await renderAndPrint(win, html, name);
  } finally {
    // Close this job's own window only: after a timeout the next job may
    // already be using a newer one.
    closeWindow(win);
  }
}

function closeWindow(win: BrowserWindow): void {
  if (printWindow === win) printWindow = null;
  if (!win.isDestroyed()) win.destroy();
}

// The page is written to a temp file and loaded with loadFile. It used to be
// loaded as a data: URL, which failed with ERR_FAILED (-2) on a Windows PC
// (2026-11-03) and put the whole encoded page into the error and the log.
let jobFile: string | null = null;

async function writeJobFile(html: string): Promise<string> {
  if (!jobFile) {
    const dir = path.join(app.getPath('temp'), 'virunthagam-pos-print');
    await fs.mkdir(dir, { recursive: true });
    jobFile = path.join(dir, 'print-job.html');
  }
  await fs.writeFile(jobFile, html, 'utf8');
  return jobFile;
}

async function renderAndPrint(win: BrowserWindow, html: string, name: string): Promise<void> {
  try {
    await win.loadFile(await writeJobFile(html));
  } catch (err) {
    // Keep the message short: the loader error can carry the whole URL.
    const raw = err instanceof Error ? err.message : String(err);
    const code = /ERR_[A-Z_]+ \(-?\d+\)/.exec(raw)?.[0] ?? raw.slice(0, 120);
    throw new PageLoadError(`Could not prepare the print page (${code}).`);
  }

  // Wait until the page is actually drawn (fonts loaded, two frames painted)
  // before printing; printing straight after load can send a blank page.
  await win.webContents.executeJavaScript(PAINTED_JS);
  await new Promise<void>((r) => setTimeout(r, PAINT_SETTLE_MS));

  const px = (await win.webContents.executeJavaScript(
    'Math.ceil(document.documentElement.getBoundingClientRect().height)',
  )) as number;
  // Slight over-allowance so the last line is never clipped; the roll is continuous.
  const heightMicrons = Math.min(MAX_PAGE_MICRONS, Math.max(20000, Math.ceil((px + 12) * PX_TO_MICRONS)));

  await new Promise<void>((resolve, reject) => {
    win.webContents.print(
      {
        //silent: true,
        deviceName: name,
        printBackground: true,
        color: false, // thermal printers are black and white
        margins: { marginType: 'none' },
        pageSize: { width: PAPER_MM * 1000, height: heightMicrons },
      },
      (success, reason) => {
        if (success) resolve();
        else reject(new Error(`Printing to "${name}" failed${reason ? `: ${reason}` : ''}.`));
      },
    );
  });
}
