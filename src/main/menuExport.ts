import { dialog, type BrowserWindow } from 'electron';
import { writeFile } from 'fs/promises';
import * as XLSX from 'xlsx';
import type { ExportResult, MenuExportPayload } from '../shared/reportTypes';

/** Quote a CSV field only when it needs it (comma, quote, or newline present). */
function csvField(value: string | number | null): string {
  const s = value === null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Menu Items page export (docs/MENU_ITEMS_PAGE.md). The renderer sends the rows it shows
 * (filters applied, in category order); the operator picks the file and its type
 * (Excel or CSV) in the save dialog. Cancelling returns { success: false } with no error.
 */
export async function exportMenuItems(win: BrowserWindow | null, payload: MenuExportPayload): Promise<ExportResult> {
  const { columns, rows } = payload;
  const dialogOptions = {
    title: 'Export menu',
    defaultPath: `menu-items_${today()}.xlsx`,
    filters: [
      { name: 'Excel Workbook', extensions: ['xlsx'] },
      { name: 'CSV', extensions: ['csv'] },
    ],
  };
  const result = win ? await dialog.showSaveDialog(win, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
  if (result.canceled || !result.filePath) return { success: false };

  try {
    if (result.filePath.toLowerCase().endsWith('.csv')) {
      const lines = [columns, ...rows].map((r) => r.map(csvField).join(','));
      // BOM so Excel reads the file as UTF-8 (Tamil item names).
      await writeFile(result.filePath, '﻿' + lines.join('\r\n'), 'utf8');
    } else {
      const sheet = XLSX.utils.aoa_to_sheet([columns, ...rows]);
      sheet['!cols'] = columns.map((c, i) => ({
        wch: Math.min(40, Math.max(c.length, ...rows.map((r) => String(r[i] ?? '').length)) + 2),
      }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, sheet, 'Menu items');
      await writeFile(result.filePath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    }
    return { success: true, path: result.filePath };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to write file' };
  }
}
