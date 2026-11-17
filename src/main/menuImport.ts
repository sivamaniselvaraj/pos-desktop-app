import { randomUUID } from 'crypto';
import { basename } from 'path';
import { dialog, type BrowserWindow } from 'electron';
import { db, type MenuImportItem } from './data';
import { config } from './config';
import { refreshMenuCache } from './menuCache';
import {
  MENU_FILE_COLUMNS,
  numOrNull,
  parseMenuFile,
  saveTable,
  todayText,
  type Cell,
  type ParsedMenuRow,
} from './menuFile';
import type { ExportResult } from '../shared/reportTypes';
import type {
  MenuUploadChange,
  MenuUploadPickResult,
  MenuUploadResult,
  MenuUploadRow,
  MenuUploadSummary,
} from '../shared/menuUploadTypes';

/**
 * menuImport.ts
 * ---------------------------------------------------------------------------
 * Settings > Menu upload (docs/MENU_UPLOAD.md). Two steps:
 *   1. pickMenuUploadFile: choose a file, read it, match each row to the menu by name and
 *      return a preview (New / Update / Unchanged / Error). Nothing is written.
 *   2. commitMenuUpload: write the New and Update rows in one database call (all or nothing).
 * The checked rows stay here between the steps; the screen only sends back a token, never
 * item data. The database function re-checks the outlet, the permission and the names.
 * Counts shown after an upload are for the screen only; nothing about the upload is stored.
 * ---------------------------------------------------------------------------
 */

interface Pending {
  token: string;
  items: MenuImportItem[];
}
/** The rows with errors of the last preview; kept after the import so the "error rows" file can still be saved. */
interface ErrorState {
  token: string;
  headers: string[];
  rows: Array<{ raw: Cell[]; error: string }>;
}
let pending: Pending | null = null;
let lastErrors: ErrorState | null = null;

/** The values of an item, either read from the menu or worked out from a file row. */
interface ItemState {
  category: string;
  price: number;
  isVeg: boolean;
  isActive: boolean;
  reason: string | null;
  container: number | null;
  taxName: string | null;
  taxPercent: number | null;
  includesTax: boolean;
  incentive: boolean;
  incType: 'percent' | 'fixed' | null;
  incValue: number | null;
  cost: number | null;
  cooking: number;
}

interface ExistingItem extends ItemState {
  id: string;
  name: string;
}

class RowError extends Error {}

const key = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

function existingFrom(i: Record<string, unknown>, categoryName: string): ExistingItem {
  const type = i.incentive_type === 'fixed' ? 'fixed' : i.incentive_type === 'percent' ? 'percent' : null;
  return {
    id: String(i.id),
    name: String(i.name ?? ''),
    category: categoryName,
    price: numOrNull(i.price) ?? 0,
    isVeg: i.is_veg !== false,
    isActive: i.is_active !== false,
    reason: i.inactive_reason ? String(i.inactive_reason) : null,
    container: numOrNull(i.container_charge),
    taxName: i.tax_name ? String(i.tax_name) : null,
    taxPercent: numOrNull(i.tax_rate_percent),
    includesTax: i.price_includes_tax === true,
    incentive: i.incentive_applicable === true,
    incType: type,
    incValue: numOrNull(i.incentive_value),
    cost: numOrNull(i.cost_price),
    cooking: numOrNull(i.cooking_time) ?? 0,
  };
}

// ---- reading cells -------------------------------------------------------

function text(c: Cell | undefined): string | null {
  return c === null || c === undefined ? null : String(c).trim() || null;
}

function parseNumber(c: Cell | undefined, msg: string, min: number, max: number, whole = false): number | null {
  if (c === null || c === undefined) return null;
  const n = typeof c === 'number' ? c : Number(String(c).replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n < min || n > max || (whole && !Number.isInteger(n))) throw new RowError(msg);
  return n;
}

function parseYesNo(c: Cell | undefined, msg: string): boolean | null {
  const s = text(c)?.toLowerCase();
  if (!s) return null;
  if (['yes', 'y', 'true', '1'].includes(s)) return true;
  if (['no', 'n', 'false', '0'].includes(s)) return false;
  throw new RowError(msg);
}

function parseVeg(c: Cell | undefined): boolean | null {
  const s = text(c)?.toLowerCase().replace(/[\s_]+/g, '-');
  if (!s) return null;
  if (['veg', 'v', 'vegetarian'].includes(s)) return true;
  if (['non-veg', 'nonveg', 'non', 'non-vegetarian'].includes(s)) return false;
  throw new RowError('Veg must be "Veg" or "Non-veg".');
}

function parseStatus(c: Cell | undefined): boolean | null {
  const s = text(c)?.toLowerCase();
  if (!s) return null;
  if (['available', 'on', 'yes', 'active'].includes(s)) return true;
  if (['off', 'unavailable', 'no', 'inactive'].includes(s)) return false;
  throw new RowError('Status must be "Available" or "Off".');
}

function parseIncType(c: Cell | undefined): 'percent' | 'fixed' | null {
  const s = text(c)?.toLowerCase();
  if (!s) return null;
  if (s === 'percent' || s === 'percentage' || s === '%') return 'percent';
  if (s === 'fixed' || s === 'amount') return 'fixed';
  throw new RowError('Incentive type must be "percent" or "fixed".');
}

// ---- tax -------------------------------------------------------------------

interface TaxOption {
  name: string;
  percent: number;
}

function taxText(name: string | null, pct: number | null): string {
  return name === null && pct === null ? '' : `${name ?? ''} ${pct ?? ''}%`.trim();
}

function resolveTax(
  options: TaxOption[],
  existing: ExistingItem | null,
  nameCell: string | null,
  pctCell: number | null,
): { name: string; percent: number } | null {
  if (nameCell === null && pctCell === null) return null;
  if (nameCell === null) throw new RowError('Tax % is given but the Tax name is empty.');
  const sameTax = (o: TaxOption) => key(o.name) === key(nameCell) && (pctCell === null || Math.abs(o.percent - pctCell) < 0.005);
  const own = existing && existing.taxName ? [{ name: existing.taxName, percent: existing.taxPercent ?? 0 }] : [];
  const hits = [...options, ...own].filter(sameTax);
  if (hits.length === 0) {
    throw new RowError(`Tax "${taxText(nameCell, pctCell)}" is not set up in Settings > Tax.`);
  }
  const distinct = new Set(hits.map((h) => h.percent));
  if (distinct.size > 1) throw new RowError(`Tax "${nameCell}" has more than one rate. Fill in the Tax % column.`);
  return { name: hits[0].name, percent: Math.round(hits[0].percent * 100) / 100 };
}

// ---- comparing -------------------------------------------------------------

const money = (n: number | null): string => (n === null ? '' : String(Math.round(n * 100) / 100));
const sameNum = (a: number | null, b: number | null): boolean => (a === null || b === null ? a === b : Math.abs(a - b) < 0.005);
const yn = (b: boolean): string => (b ? 'Yes' : 'No');
const statusText = (s: ItemState): string => (s.isActive ? 'Available' : 'Off');

function diff(before: ExistingItem, after: ItemState): MenuUploadChange[] {
  const out: MenuUploadChange[] = [];
  const add = (field: string, from: string, to: string) => out.push({ field, from: from || 'blank', to: to || 'blank' });
  if (key(before.category) !== key(after.category)) add('Category', before.category, after.category);
  if (!sameNum(before.price, after.price)) add('Price', money(before.price), money(after.price));
  if (before.isVeg !== after.isVeg) add('Veg', before.isVeg ? 'Veg' : 'Non-veg', after.isVeg ? 'Veg' : 'Non-veg');
  if (before.isActive !== after.isActive) {
    add('Status', statusText(before), after.isActive ? 'Available' : `Off (${after.reason ?? ''})`);
  } else if (!after.isActive && (before.reason ?? '') !== (after.reason ?? '')) {
    add('Off reason', before.reason ?? '', after.reason ?? '');
  }
  if (!sameNum(before.container, after.container)) add('Container charge', money(before.container), money(after.container));
  if (before.taxName !== after.taxName || !sameNum(before.taxPercent, after.taxPercent)) {
    add('Tax', taxText(before.taxName, before.taxPercent), taxText(after.taxName, after.taxPercent));
  }
  if (before.includesTax !== after.includesTax) add('Price includes tax', yn(before.includesTax), yn(after.includesTax));
  if (before.incentive !== after.incentive) add('Incentive', yn(before.incentive), yn(after.incentive));
  if (after.incentive && before.incType !== after.incType) add('Incentive type', before.incType ?? '', after.incType ?? '');
  if (after.incentive && !sameNum(before.incValue, after.incValue)) add('Incentive value', money(before.incValue), money(after.incValue));
  if (!sameNum(before.cost, after.cost)) add('Cost price', money(before.cost), money(after.cost));
  if (before.cooking !== after.cooking) add('Cooking time', String(before.cooking), `${after.cooking} min`);
  return out;
}

// ---- one row ---------------------------------------------------------------

interface Context {
  taxOptions: TaxOption[];
  categories: Map<string, { name: string; isActive: boolean }>;
}

interface RowOutcome {
  result: MenuUploadResult;
  changes: MenuUploadChange[];
  newCategory: boolean;
  item: MenuImportItem | null;
}

function evaluateRow(r: ParsedMenuRow, existing: ExistingItem | null, ctx: Context): RowOutcome {
  const c = r.cells;
  const categoryCell = text(c.Category);
  const name = text(c.Name);
  if (!categoryCell) throw new RowError('Category is required.');
  if (categoryCell.length > 60) throw new RowError('The category name must be 60 characters or fewer.');
  if (!name) throw new RowError('Name is required.');
  if (name.length > 200) throw new RowError('The name must be 200 characters or fewer.');
  if (text(c.Price) === null) throw new RowError('Price is required.');
  const price = parseNumber(c.Price, 'Price must be a number, 0 or more.', 0, 1_000_000) as number;

  const veg = parseVeg(c.Veg);
  const active = parseStatus(c.Status);
  const reasonCell = text(c['Off reason']);
  if (reasonCell && reasonCell.length > 200) throw new RowError('The off reason must be 200 characters or fewer.');
  const container = parseNumber(c['Container charge'], 'Container charge must be a percentage between 0 and 100.', 0, 100);
  const taxPct = parseNumber(c['Tax %'], 'Tax % must be a number between 0 and 100.', 0, 100);
  const includes = parseYesNo(c['Price includes tax'], 'Price includes tax must be Yes or No.');
  const incentive = parseYesNo(c.Incentive, 'Incentive must be Yes or No.');
  const incType = parseIncType(c['Incentive type']);
  const incValue = parseNumber(c['Incentive value'], 'Incentive value must be a number, 0 or more.', 0, 1_000_000);
  const cost = parseNumber(c['Cost price'], 'Cost price must be a number, 0 or more.', 0, 1_000_000);
  const cooking = parseNumber(c['Cooking time'], 'Cooking time must be whole minutes.', 0, 1000, true);

  const tax = resolveTax(ctx.taxOptions, existing, text(c.Tax), taxPct);
  if (!existing && !tax) throw new RowError('Tax is required for a new item.');

  const cat = ctx.categories.get(key(categoryCell));
  const base: ItemState = existing ?? {
    category: categoryCell,
    price,
    isVeg: true,
    isActive: true,
    reason: null,
    container: null,
    taxName: null,
    taxPercent: null,
    includesTax: false,
    incentive: false,
    incType: null,
    incValue: null,
    cost: null,
    cooking: 0,
  };
  const fin: ItemState = {
    ...base,
    category: cat ? cat.name : categoryCell,
    price,
    isVeg: veg ?? base.isVeg,
    isActive: active ?? base.isActive,
    container: container ?? base.container,
    taxName: tax ? tax.name : base.taxName,
    taxPercent: tax ? tax.percent : base.taxPercent,
    includesTax: includes ?? base.includesTax,
    incentive: incentive ?? base.incentive,
    incType: incType ?? base.incType,
    incValue: incValue ?? base.incValue,
    cost: cost ?? base.cost,
    cooking: cooking ?? base.cooking,
  };

  if (fin.incentive) {
    if (!fin.incType || fin.incValue === null) {
      throw new RowError('Incentive is Yes, so Incentive type and Incentive value are needed.');
    }
    if (fin.incType === 'percent' && fin.incValue > 100) throw new RowError('The incentive percentage cannot be more than 100.');
  } else {
    fin.incType = null;
    fin.incValue = null;
  }

  if (fin.isActive) {
    fin.reason = null;
  } else {
    fin.reason = reasonCell ?? (existing && !existing.isActive ? existing.reason : null);
    if (!fin.reason) throw new RowError('Status is Off but Off reason is empty.');
  }
  if (cat && !cat.isActive && fin.isActive) {
    throw new RowError(`Category "${cat.name}" is turned off. Turn it on first, or set Status to Off.`);
  }

  const changes = existing ? diff(existing, fin) : [];
  const result: MenuUploadResult = !existing ? 'new' : changes.length === 0 ? 'unchanged' : 'update';
  const item: MenuImportItem | null =
    result === 'unchanged'
      ? null
      : {
          id: existing ? existing.id : null,
          name: existing ? existing.name : name,
          category: fin.category,
          price: fin.price,
          isVeg: fin.isVeg,
          isActive: fin.isActive,
          inactiveReason: fin.reason,
          containerCharge: fin.container,
          costPrice: fin.cost,
          cookingTime: fin.cooking,
          taxName: fin.taxName ?? '',
          taxPercent: fin.taxPercent ?? 0,
          priceIncludesTax: fin.includesTax,
          incentiveApplicable: fin.incentive,
          incentiveType: fin.incentive ? fin.incType : null,
          incentiveValue: fin.incentive ? fin.incValue : null,
        };
  return { result, changes, newCategory: !cat, item };
}

// ---- step 1: pick and preview -----------------------------------------------

export async function pickMenuUploadFile(win: BrowserWindow | null): Promise<MenuUploadPickResult> {
  const options = {
    title: 'Choose the menu file',
    properties: ['openFile' as const],
    filters: [{ name: 'Excel or CSV', extensions: ['xlsx', 'csv'] }],
  };
  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || picked.filePaths.length === 0) return { status: 'cancelled' };
  const path = picked.filePaths[0];

  try {
    if (!config.outletId) throw new Error('OUTLET_ID is not configured for this machine.');
    const file = await parseMenuFile(path);
    const [{ items, categories }, taxes] = await Promise.all([db.menu.listForFile(config.outletId), db.orderEntry.getTaxRates()]);

    const catById = new Map(categories.map((c) => [c.id, c]));
    const existing = items.map((i) => existingFrom(i, i.category_id ? (catById.get(String(i.category_id))?.name ?? '') : ''));
    const byName = new Map<string, ExistingItem[]>();
    for (const e of existing) byName.set(key(e.name), [...(byName.get(key(e.name)) ?? []), e]);

    const taxOptions: TaxOption[] = [{ name: 'No tax', percent: 0 }];
    if (taxes.defaultRate.configured) taxOptions.push({ name: taxes.defaultRate.name, percent: taxes.defaultRate.ratePercent });
    for (const r of Object.values(taxes.byCategory)) taxOptions.push({ name: r.name, percent: r.ratePercent });
    const ctx: Context = {
      taxOptions,
      categories: new Map(categories.map((c) => [key(c.name), { name: c.name, isActive: c.isActive }])),
    };

    const rowsByName = new Map<string, number[]>();
    for (const r of file.rows) {
      const n = text(r.cells.Name);
      if (n) rowsByName.set(key(n), [...(rowsByName.get(key(n)) ?? []), r.row]);
    }

    const out: MenuUploadRow[] = [];
    const items2: MenuImportItem[] = [];
    const errorRows: ErrorState['rows'] = [];
    const newCats = new Map<string, string>();
    for (const r of file.rows) {
      const name = text(r.cells.Name) ?? '';
      const row: MenuUploadRow = {
        row: r.row,
        result: 'error',
        category: text(r.cells.Category) ?? '',
        name,
        price: r.cells.Price === null || r.cells.Price === undefined ? '' : String(r.cells.Price),
        changes: [],
        newCategory: false,
        error: null,
      };
      try {
        const same = name ? (byName.get(key(name)) ?? []) : [];
        const inFile = name ? (rowsByName.get(key(name)) ?? []) : [];
        if (inFile.length > 1) {
          throw new RowError(`"${name}" is in the file ${inFile.length} times (rows ${inFile.join(', ')}). No database change for this item.`);
        }
        if (same.length > 1) {
          const cats = same.map((s) => s.category || 'No category');
          throw new RowError(
            new Set(cats).size > 1
              ? `"${name}" is in ${same.length} categories (${cats.join(', ')}). No database change for this item.`
              : `"${name}" is on the menu ${same.length} times (in ${cats[0]}). No database change for this item.`,
          );
        }
        const o = evaluateRow(r, same[0] ?? null, ctx);
        row.result = o.result;
        row.changes = o.changes;
        row.newCategory = o.newCategory;
        if (o.item) items2.push(o.item);
        if (o.newCategory) newCats.set(key(row.category), row.category);
      } catch (err) {
        if (!(err instanceof RowError)) throw err;
        row.result = 'error';
        row.error = err.message;
        errorRows.push({ raw: r.raw, error: err.message });
      }
      out.push(row);
    }

    const counts = { new: 0, update: 0, unchanged: 0, error: 0 };
    for (const r of out) counts[r.result]++;
    const named = new Set(rowsByName.keys());
    const missingItems = existing.filter((e) => !named.has(key(e.name))).map((e) => ({ name: e.name, category: e.category || 'No category' }));

    const token = randomUUID();
    pending = { token, items: items2 };
    lastErrors = { token, headers: file.headers, rows: errorRows };
    return {
      status: 'ok',
      preview: {
        token,
        fileName: basename(path),
        totalRows: out.length,
        counts,
        rows: out,
        newCategories: [...newCats.values()],
        missingItems,
      },
    };
  } catch (err) {
    pending = null;
    lastErrors = null;
    return { status: 'error', message: err instanceof Error ? err.message : 'The file could not be checked.' };
  }
}

// ---- step 2: save ---------------------------------------------------------------

/** Writes the New and Update rows of the preview in one database call (all or nothing). */
export async function commitMenuUpload(token: string): Promise<MenuUploadSummary> {
  if (!pending || pending.token !== token) throw new Error('This preview is no longer current. Choose the file again.');
  if (pending.items.length === 0) throw new Error('There is nothing to import.');
  const p = pending;
  const r = await db.menu.importItems(p.items);
  pending = null;
  await refreshMenuCache(); // phones and New order read the menu from the cache
  return { created: r.created, updated: r.updated, categoriesCreated: r.categoriesCreated, skippedErrors: lastErrors && lastErrors.token === token ? lastErrors.rows.length : 0 };
}

/** The rows with errors as a file (the same columns as the upload, plus an Error column) to fix and upload again. */
export function saveUploadErrorRows(win: BrowserWindow | null, token: string): Promise<ExportResult> {
  if (!lastErrors || lastErrors.token !== token) return Promise.resolve({ success: false, error: 'This preview is no longer current. Choose the file again.' });
  const headers = lastErrors.headers.length > 0 ? lastErrors.headers : [...MENU_FILE_COLUMNS];
  return saveTable(win, {
    title: 'Save the rows with errors',
    defaultName: `menu-upload-errors_${todayText()}`,
    columns: [...headers, 'Error'],
    rows: lastErrors.rows.map((e) => [...e.raw, e.error]),
    sheetName: 'Rows with errors',
  });
}
