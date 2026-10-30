import { BrowserWindow } from 'electron';
import { taxBillLines } from '../shared/orderTotals';
import type { FoodOrder } from '../shared/types';
import { parseHeaderConfig, splitBrLines } from './printerManager';

/**
 * htmlPrint.ts
 * ---------------------------------------------------------------------------
 * HTML print path for the bill and the KOT (80 mm thermal roll). The layouts
 * mirror the ESC/POS ones in printerManager.ts; printing is silent (no dialog)
 * to the printer already mapped in Settings, through the OS driver.
 *
 * Differences from the direct (ESC/POS) path: no printer cut / cash-drawer
 * commands (the printer driver's own "cut at end of document" setting applies)
 * and the page height is measured from the content so a roll is not wasted.
 * ---------------------------------------------------------------------------
 */

const PAPER_MM = 80;
const PX_TO_MICRONS = 25400 / 96;

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const money = (n: number) => `₹ ${Number(n).toFixed(2)}`;

const CSS = `
  @page { size: ${PAPER_MM}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { width: ${PAPER_MM}mm; padding: 2mm 4mm 4mm; font-family: Arial, 'Segoe UI', sans-serif;
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
    `<div class="c lg">${esc(header?.restaurantName?.trim() || order.outlet?.name || 'FOOD ORDER PRINTER')}</div>`,
  );
  const headerLines = splitBrLines(header?.headerText);
  if (headerLines.length > 0) {
    for (const l of headerLines) out.push(`<div class="c">${esc(l)}</div>`);
  } else {
    if (order.outlet?.address) out.push(`<div class="c">${esc(order.outlet.address)}</div>`);
    const meta = [order.outlet?.city, order.outlet?.phone, order.outlet?.gstNumber].filter(Boolean).join(' | ');
    if (meta) out.push(`<div class="c">${esc(meta)}</div>`);
  }
  out.push('<div class="rule"></div>');

  if (isDuplicate) {
    out.push('<div class="c"><span class="inv">DUPLICATE BILL</span></div><div class="rule"></div>');
  }

  out.push(`<div>Name: ${esc(order.customerName)}</div>`);
  out.push('<div style="height:4px"></div>');
  out.push(kv('Date', new Date(order.createdAt).toLocaleString('en-IN')));
  out.push(
    kv(
      'Bill No.',
      order.orderNumbers && order.orderNumbers.length > 0 ? order.orderNumbers.join(', ') : String(order.orderNumber),
    ),
  );
  if (order.invoiceNumber) out.push(kv('Invoice No.', order.invoiceNumber));
  out.push(kv('Type', order.orderType.toUpperCase()));
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
        `<td class="n">${money(item.unitPrice)}</td><td class="n">${money(item.unitPrice * item.quantity)}</td></tr>${note}`
      );
    })
    .join('');
  out.push(
    `<table><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Price</th><th class="n">Amount</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`,
  );
  out.push('<div class="rule"></div>');

  const line = (k: string, v: string) => `<div class="sub"><span>${esc(k)}</span><span>${esc(v)}</span></div>`;
  out.push(line('Total Qty', String(totalQty)));
  out.push(line('Subtotal', money(order.subtotal)));
  for (const t of taxBillLines(order.taxBreakdown, order.tax)) out.push(line(t.label, money(t.amount)));
  if (order.containerCharge && order.containerCharge > 0) out.push(line('Container Charge', money(order.containerCharge)));
  if (order.discount && order.discount > 0) {
    out.push(line(order.isComplimentary ? 'Complimentary' : 'Discount', '-' + money(order.discount)));
  }
  out.push(`<div class="thick"></div><div class="c lg">TOTAL ${esc(money(order.total))}</div><div class="thick"></div>`);

  if (order.specialNotes) {
    out.push(`<div class="c b">Special Notes</div><div>${esc(order.specialNotes)}</div><div style="height:4px"></div>`);
  }
  const footer = splitBrLines(header?.footerText);
  for (const f of footer) out.push(`<div class="c">${esc(f)}</div>`);
  if (footer.length) out.push('<div style="height:4px"></div>');
  out.push('<div class="c">Thank you! Please visit again.</div><div class="c">Powered by PrintPro</div>');
  return page(out.join(''));
}

export function renderKotHtml(order: FoodOrder): string {
  const out: string[] = [];
  const title = order.orderType === 'pickup' ? 'TAKEAWAY KOT' : 'KOT';
  out.push(`<div class="c lg">${title}</div>`);
  if (order.orderType !== 'pickup' && order.isRunningOrder) out.push('<div class="c b">** RUNNING ORDER **</div>');
  out.push('<div class="rule"></div>');

  const table =
    order.tableNumber != null && String(order.tableNumber).trim() !== '' ? String(order.tableNumber) : '-';
  out.push(`<div class="xl">Table: ${esc(table)}</div>`);
  out.push(kv('Order #', String(order.orderNumber)));
  out.push(kv('Type', order.orderType.toUpperCase()));
  out.push(kv('Time', new Date(order.createdAt).toLocaleString('en-IN')));
  if (order.placedBy) out.push(kv('Placed By', order.placedBy));
  out.push('<div class="rule"></div>');

  let totalQty = 0;
  const rows = order.items
    .map((item) => {
      totalQty += item.quantity;
      const note = item.specialInstructions
        ? `<div class="note">* ${esc(item.specialInstructions)}</div>`
        : '';
      return `<tr><td class="kotq">${item.quantity}</td><td class="kotn">${esc(item.name)}${note}</td></tr>`;
    })
    .join('');
  out.push(`<table><thead><tr><th>Qty</th><th>Item</th></tr></thead><tbody>${rows}</tbody></table>`);
  out.push('<div class="rule"></div>');
  out.push(`<div class="lg">Total Qty: ${totalQty}</div>`);
  if (order.specialNotes) {
    out.push(`<div class="rule"></div><div class="b">Notes:</div><div>${esc(order.specialNotes)}</div>`);
  }
  return page(out.join(''));
}

export function renderTestHtml(printerName: string): string {
  return page(
    `<div class="c lg">TEST PRINT</div><div class="rule"></div>` +
      kv('Printer', printerName) +
      kv('Time', new Date().toLocaleString('en-IN')) +
      kv('Method', 'HTML (Electron)') +
      `<div class="rule"></div><div class="c">If you can read this,</div><div class="c">HTML printing works.</div>`,
  );
}

// Jobs are printed strictly one at a time. A KOT and a bill fired together (same
// printer, two hidden windows) otherwise collide in the driver and one is lost.
let queue: Promise<void> = Promise.resolve();
const GAP_MS = 700; // let the driver/spooler finish taking one job before the next starts

/** Print an HTML document silently to a named OS printer (queued, one job at a time). */
export function printHtml(html: string, printerName: string): Promise<void> {
  const job = queue.then(() => printHtmlNow(html, printerName));
  // Keep the chain alive after a failure, and pause between jobs.
  queue = job.then(
    () => new Promise<void>((r) => setTimeout(r, GAP_MS)),
    () => new Promise<void>((r) => setTimeout(r, GAP_MS)),
  );
  return job;
}

async function printHtmlNow(html: string, printerName: string): Promise<void> {
  const name = (printerName ?? '').trim();
  if (!name) throw new Error('No printer selected.');

  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
  });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

    const printers = await win.webContents.getPrintersAsync();
    if (!printers.some((p) => p.name === name)) {
      throw new Error(
        `Printer "${name}" was not found in the OS. Check it is installed and the name matches exactly.`,
      );
    }

    const px = (await win.webContents.executeJavaScript(
      'Math.ceil(document.documentElement.getBoundingClientRect().height)',
    )) as number;
    // Slight over-allowance so the last line is never clipped; the roll is continuous.
    const heightMicrons = Math.max(20000, Math.ceil((px + 12) * PX_TO_MICRONS));

    await new Promise<void>((resolve, reject) => {
      win.webContents.print(
        {
          silent: true,
          deviceName: name,
          printBackground: true,
          margins: { marginType: 'none' },
          pageSize: { width: PAPER_MM * 1000, height: heightMicrons },
        },
        (success, reason) => {
          if (success) resolve();
          else reject(new Error(`Printing to "${name}" failed${reason ? `: ${reason}` : ''}.`));
        },
      );
    });
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
