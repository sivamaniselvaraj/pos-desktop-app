import { dialog, type BrowserWindow } from 'electron';
import { writeFile } from 'fs/promises';
import * as XLSX from 'xlsx';
import { db } from './data';
import { config } from './config';
import type { ExportResult } from '../shared/reportTypes';
import { MENU_FILE_COLUMNS, MENU_FILE_HELP, recordToCells, saveTable, todayText, type Cell } from './menuFile';

/**
 * Menu file downloads (docs/MENU_ITEMS_PAGE.md, docs/MENU_UPLOAD.md). One format everywhere: the
 * same columns the menu upload reads. The items come from the database with the whole file
 * column set (cost price and cooking time too), so a downloaded file can be edited and uploaded.
 * Cancelling the save dialog returns { success: false } with no error.
 */

async function loadRows(): Promise<Cell[][]> {
  if (!config.outletId) throw new Error('OUTLET_ID is not configured for this machine.');
  const { items, categories } = await db.menu.listForFile(config.outletId);
  const catById = new Map(categories.map((c) => [c.id, c]));
  const catName = (i: Record<string, unknown>) => (i.category_id ? (catById.get(String(i.category_id))?.name ?? '') : '');
  const order = (i: Record<string, unknown>) => {
    const c = i.category_id ? catById.get(String(i.category_id)) : undefined;
    return c?.sortOrder ?? Number.MAX_SAFE_INTEGER;
  };
  const sorted = [...items].sort(
    (a, b) =>
      order(a) - order(b) ||
      catName(a).localeCompare(catName(b)) ||
      String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { sensitivity: 'base' }),
  );
  return sorted.map((i) => recordToCells(i, catName(i)));
}

/** Settings > Menu upload: the whole menu of this outlet. */
export async function exportCurrentMenu(win: BrowserWindow | null): Promise<ExportResult> {
  try {
    const rows = await loadRows();
    if (rows.length === 0) return { success: false, error: 'The menu has no items yet.' };
    return saveTable(win, { title: 'Download current menu', defaultName: `menu-items_${todayText()}`, columns: [...MENU_FILE_COLUMNS], rows });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Download failed' };
  }
}

/** Settings > Menu upload: the column names, plus a Help sheet (Excel) saying what each takes. */
export function exportMenuTemplate(win: BrowserWindow | null): Promise<ExportResult> {
  return saveTable(win, {
    title: 'Download menu template',
    defaultName: 'menu-upload-template',
    columns: [...MENU_FILE_COLUMNS],
    rows: [],
    extraSheet: {
      name: 'Help',
      rows: [
        ['Column', 'Needed', 'What to enter'],
        ...MENU_FILE_HELP,
        [],
        ['Example', '', 'Breakfast | Idli (2 pcs) | 40 | Veg | Available | | | | 0 | GST | 5 | No | No | | | 12 | 10'],
        ['Notes', '', 'Leave a cell empty to keep the item’s current value. Nothing is deleted. Rows are matched by Name.'],
      ],
    },
  });
}
