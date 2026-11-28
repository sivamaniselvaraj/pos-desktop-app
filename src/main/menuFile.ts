import { dialog, type BrowserWindow } from 'electron';
import { readFile, writeFile } from 'fs/promises';
import * as XLSX from 'xlsx';
import type { ExportResult } from '../shared/reportTypes';

/**
 * menuFile.ts
 * ---------------------------------------------------------------------------
 * The menu file (docs/MENU_UPLOAD.md): one column list used by
 * "Download current menu" and "Download template", and read back by the upload.
 * Excel (.xlsx) or CSV. No Item id: items are matched by name.
 * ---------------------------------------------------------------------------
 */

export type Cell = string | number | null;

export const MENU_FILE_COLUMNS = [
  'Category',
  'Name',
  'Price',
  'Veg',
  'Status',
  'Off reason',
  'Off since',
  'Off by',
  'Container charge',
  'Tax',
  'Tax %',
  'Price includes tax',
  'Incentive',
  'Incentive type',
  'Incentive value',
  'Cost price',
  'Cooking time',
  'Search key',
] as const;
export type MenuFileColumn = (typeof MENU_FILE_COLUMNS)[number];

/** Most data rows one upload may hold (the database function enforces the same limit). */
export const MAX_UPLOAD_ROWS = 1000;

export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local date and time as "2026-11-17 08:12". */
function localDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One menu_items row (from db.menu.listForFile) as the cells of the file, in MENU_FILE_COLUMNS order. */
export function recordToCells(i: Record<string, unknown>, categoryName: string): Cell[] {
  const off = i.is_active === false;
  const text = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
  const yesNo = (v: unknown): string | null => (v === null || v === undefined ? null : v ? 'Yes' : 'No');
  return [
    categoryName,
    text(i.name),
    numOrNull(i.price),
    i.is_veg == null ? null : i.is_veg ? 'Veg' : 'Non-veg',
    off ? 'Off' : 'Available',
    off ? text(i.inactive_reason) : null,
    off && i.inactive_since ? localDateTime(String(i.inactive_since)) : null,
    off ? text(i.inactive_by_name) : null,
    numOrNull(i.container_charge),
    text(i.tax_name),
    numOrNull(i.tax_rate_percent),
    yesNo(i.price_includes_tax),
    i.incentive_applicable ? 'Yes' : yesNo(i.incentive_applicable),
    i.incentive_applicable ? text(i.incentive_type) : null,
    i.incentive_applicable ? numOrNull(i.incentive_value) : null,
    numOrNull(i.cost_price),
    numOrNull(i.cooking_time),
    text(i.search_key),
  ];
}

/** The Help sheet of the template: what each column takes. */
export const MENU_FILE_HELP: Array<[string, string, string]> = [
  ['Category', 'Required', 'Category name. A name that does not exist yet creates the category.'],
  ['Name', 'Required', 'The item name. Items are matched by name (ignoring capitals and spaces at the ends). A name that is not on the menu creates a new item; a renamed item looks like a new one.'],
  ['Price', 'Required', 'A number, 0 or more.'],
  ['Veg', 'Optional', 'Veg or Non-veg. Blank: Veg for a new item, unchanged for an existing one.'],
  ['Status', 'Optional', 'Available or Off. Blank: Available for a new item, unchanged for an existing one.'],
  ['Off reason', 'When Status is Off', 'Why the item is off. Needed when an item is turned off.'],
  ['Off since', 'Ignored', 'Shown in the export only. The system sets it.'],
  ['Off by', 'Ignored', 'Shown in the export only. The system sets it.'],
  ['Container charge', 'Optional', 'A percentage from 0 to 100.'],
  ['Tax', 'Required for a new item', 'The name of a tax set up in Settings > Tax, or No tax.'],
  ['Tax %', 'Required for a new item', 'That tax’s percentage.'],
  ['Price includes tax', 'Optional', 'Yes or No. Blank: No for a new item.'],
  ['Incentive', 'Optional', 'Yes or No. Blank: No for a new item.'],
  ['Incentive type', 'When Incentive is Yes', 'percent or fixed.'],
  ['Incentive value', 'When Incentive is Yes', '0 or more (at most 100 for percent).'],
  ['Cost price', 'Optional', 'A number, 0 or more.'],
  ['Cooking time', 'Optional', 'Whole minutes.'],
  ['Search key', 'Optional', 'Extra words the New order search finds the item by (for example: tandoor spicy starter). Blank: none for a new item, unchanged for an existing one.'],
];

/** Quote a CSV field only when it needs it (comma, quote, or newline present). */
function csvField(value: Cell): string {
  const s = value === null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function todayText(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Asks where to save and writes the table as Excel (default) or CSV, by the chosen file's
 * extension. Cancelling returns { success: false } with no error. An Excel file may carry a
 * second sheet (the template's Help).
 */
export async function saveTable(
  win: BrowserWindow | null,
  o: { title: string; defaultName: string; columns: string[]; rows: Cell[][]; sheetName?: string; extraSheet?: { name: string; rows: Cell[][] } },
): Promise<ExportResult> {
  const dialogOptions = {
    title: o.title,
    defaultPath: `${o.defaultName}.xlsx`,
    filters: [
      { name: 'Excel Workbook', extensions: ['xlsx'] },
      { name: 'CSV', extensions: ['csv'] },
    ],
  };
  const result = win ? await dialog.showSaveDialog(win, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
  if (result.canceled || !result.filePath) return { success: false };

  try {
    if (result.filePath.toLowerCase().endsWith('.csv')) {
      const lines = [o.columns, ...o.rows].map((r) => r.map(csvField).join(','));
      // BOM so Excel reads the file as UTF-8 (Tamil item names).
      await writeFile(result.filePath, '\ufeff' + lines.join('\r\n'), 'utf8');
    } else {
      const sheet = XLSX.utils.aoa_to_sheet([o.columns, ...o.rows]);
      sheet['!cols'] = o.columns.map((c, i) => ({
        wch: Math.min(40, Math.max(c.length, ...o.rows.map((r) => String(r[i] ?? '').length)) + 2),
      }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, sheet, o.sheetName ?? 'Menu items');
      if (o.extraSheet) {
        const extra = XLSX.utils.aoa_to_sheet(o.extraSheet.rows);
        extra['!cols'] = [{ wch: 20 }, { wch: 24 }, { wch: 110 }];
        XLSX.utils.book_append_sheet(wb, extra, o.extraSheet.name);
      }
      await writeFile(result.filePath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    }
    return { success: true, path: result.filePath };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to write file' };
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** One data row of an uploaded file. `row` is the row number in the file; `cells` holds the known columns by name (null = empty). */
export interface ParsedMenuRow {
  row: number;
  cells: Partial<Record<MenuFileColumn, Cell>>;
  /** The row as it is in the file, aligned with ParsedMenuFile.headers (for the "error rows" file). */
  raw: Cell[];
}

export interface ParsedMenuFile {
  /** The header row as written in the file. */
  headers: string[];
  /** Which known columns the file has. */
  present: Set<MenuFileColumn>;
  rows: ParsedMenuRow[];
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

const HEADER_ALIASES: Record<string, MenuFileColumn> = {
  ...Object.fromEntries(MENU_FILE_COLUMNS.map((c) => [norm(c), c])),
  'item name': 'Name',
  'item': 'Name',
  'tax percent': 'Tax %',
  'tax rate': 'Tax %',
  'container charge %': 'Container charge',
  'cooking time (min)': 'Cooking time',
  'cooking time (minutes)': 'Cooking time',
  'search_key': 'Search key',
  'search keys': 'Search key',
  'search keywords': 'Search key',
  'keywords': 'Search key',
};

function cleanCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (v instanceof Date) return v.toISOString();
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Reads the first sheet of an .xlsx or .csv file. Throws an Error with a message fit for the screen. */
export async function parseMenuFile(path: string): Promise<ParsedMenuFile> {
  const lower = path.toLowerCase();
  const isCsv = lower.endsWith('.csv');
  if (!isCsv && !lower.endsWith('.xlsx')) throw new Error('Choose an Excel (.xlsx) or CSV (.csv) file.');

  let wb: XLSX.WorkBook;
  try {
    const buf = await readFile(path);
    let csv = isCsv ? buf.toString('utf8') : '';
    if (csv.charCodeAt(0) === 0xfeff) csv = csv.slice(1); // the BOM that Excel adds
    wb = isCsv ? XLSX.read(csv, { type: 'string', raw: true }) : XLSX.read(buf, { type: 'buffer' });
  } catch {
    throw new Error('The file could not be read. Check that it is a valid Excel or CSV file and is not open in another program.');
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws['!ref']) throw new Error('The file is empty.');
  const firstRow = XLSX.utils.decode_range(ws['!ref']).s.r;
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: true });

  const headerIdx = grid.findIndex((r) => r.some((c) => cleanCell(c) !== null));
  if (headerIdx < 0) throw new Error('The file is empty.');
  const headers = grid[headerIdx].map((c) => String(cleanCell(c) ?? ''));
  const colOf: Array<MenuFileColumn | null> = headers.map((h) => HEADER_ALIASES[norm(h)] ?? null);
  const present = new Set(colOf.filter((c): c is MenuFileColumn => c !== null));

  const missing = (['Category', 'Name', 'Price'] as const).filter((c) => !present.has(c));
  if (missing.length > 0) {
    throw new Error(
      `The file has no ${missing.map((m) => `"${m}"`).join(', ')} column. Use the first row for the column names, or download the template.`,
    );
  }

  const rows: ParsedMenuRow[] = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const raw = headers.map((_, c) => cleanCell(grid[i][c]));
    if (raw.every((c) => c === null)) continue;
    const cells: Partial<Record<MenuFileColumn, Cell>> = {};
    colOf.forEach((col, c) => {
      if (col && cells[col] === undefined) cells[col] = raw[c];
    });
    rows.push({ row: firstRow + i + 1, cells, raw });
  }
  if (rows.length === 0) throw new Error('The file has a header row but no items.');
  if (rows.length > MAX_UPLOAD_ROWS) {
    throw new Error(`The file has ${rows.length} rows. Upload at most ${MAX_UPLOAD_ROWS} rows at a time.`);
  }
  return { headers, present, rows };
}
