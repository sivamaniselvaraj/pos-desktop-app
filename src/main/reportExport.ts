import { dialog, type BrowserWindow } from 'electron';
import { writeFile } from 'fs/promises';
import * as XLSX from 'xlsx';
import type { SalesReportRow, TopItemRow } from '../shared/types';

export interface SalesReportExportPayload {
  rows: SalesReportRow[];
  topItems: TopItemRow[];
  format: 'csv' | 'xlsx';
  range: { from: string; to: string };
}

export interface ExportResult {
  success: boolean;
  path?: string;
  error?: string;
}

/** Quote a CSV field only when it needs it (comma, quote, or newline present). */
function csvField(value: string | number): string {
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildCsv(rows: SalesReportRow[], topItems: TopItemRow[]): string {
  const lines: string[] = [];

  lines.push('Sales by Bucket');
  lines.push(['Date', 'Orders', 'Tax', 'Net Total', 'Avg Order Value'].map(csvField).join(','));
  for (const r of rows) {
    lines.push(
      [r.date, r.orderCount, r.taxTotal.toFixed(2), r.netTotal.toFixed(2), r.avgOrderValue.toFixed(2)]
        .map(csvField)
        .join(','),
    );
  }

  lines.push('');
  lines.push('Top Items (by quantity sold)');
  lines.push(['Item', 'Qty Sold', 'Revenue'].map(csvField).join(','));
  for (const item of topItems) {
    lines.push([item.name, item.quantitySold, item.revenue.toFixed(2)].map(csvField).join(','));
  }

  return lines.join('\r\n');
}

function buildXlsxBuffer(rows: SalesReportRow[], topItems: TopItemRow[]): Buffer {
  const wb = XLSX.utils.book_new();

  const salesSheet = XLSX.utils.json_to_sheet(
    rows.map((r) => ({
      Date: r.date,
      Orders: r.orderCount,
      Tax: Number(r.taxTotal.toFixed(2)),
      'Net Total': Number(r.netTotal.toFixed(2)),
      'Avg Order Value': Number(r.avgOrderValue.toFixed(2)),
    })),
  );
  XLSX.utils.book_append_sheet(wb, salesSheet, 'Sales by Bucket');

  const itemsSheet = XLSX.utils.json_to_sheet(
    topItems.map((item) => ({
      Item: item.name,
      'Qty Sold': item.quantitySold,
      Revenue: Number(item.revenue.toFixed(2)),
    })),
  );
  XLSX.utils.book_append_sheet(wb, itemsSheet, 'Top Items');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/**
 * Prompt the operator for a save location, then write the sales report as
 * CSV or XLSX. Returns { success: false } (no error) if the operator
 * cancelled the dialog — that's not a failure worth surfacing as an error.
 */
export async function exportSalesReport(
  win: BrowserWindow | null,
  payload: SalesReportExportPayload,
): Promise<ExportResult> {
  const { rows, topItems, format, range } = payload;
  const ext = format === 'xlsx' ? 'xlsx' : 'csv';
  const defaultPath = `sales-report_${range.from}_to_${range.to}.${ext}`;

  const dialogOptions = {
    defaultPath,
    filters:
      format === 'xlsx'
        ? [{ name: 'Excel Workbook', extensions: ['xlsx'] }]
        : [{ name: 'CSV', extensions: ['csv'] }],
  };

  const result = win
    ? await dialog.showSaveDialog(win, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions);

  if (result.canceled || !result.filePath) {
    return { success: false }; // cancelled — not an error
  }

  try {
    if (format === 'xlsx') {
      await writeFile(result.filePath, buildXlsxBuffer(rows, topItems));
    } else {
      // \uFEFF BOM so Excel opens this as UTF-8 rather than Latin-1 — matters
      // for non-ASCII item names (e.g. Tamil script items seen earlier in
      // this menu), not for the numeric columns, which are plain ASCII.
      await writeFile(result.filePath, '\uFEFF' + buildCsv(rows, topItems), 'utf8');
    }
    return { success: true, path: result.filePath };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to write file' };
  }
}
