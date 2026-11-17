/**
 * Types for Settings > Menu upload (docs/MENU_UPLOAD.md): the preview the screen shows
 * and the result of an import. The file itself is read in the main process.
 */
import type { ExportResult } from './reportTypes';

export type MenuUploadResult = 'new' | 'update' | 'unchanged' | 'error';

/** One value that an upload changes on an existing item, as text for the preview. */
export interface MenuUploadChange {
  field: string;
  from: string;
  to: string;
}

/** One row of the file after matching it to the menu. `row` is the row number in the file. */
export interface MenuUploadRow {
  row: number;
  result: MenuUploadResult;
  category: string;
  name: string;
  price: string;
  /** Update rows: what changes. */
  changes: MenuUploadChange[];
  /** New rows: the category does not exist yet and will be created. */
  newCategory: boolean;
  /** Error rows: why the row is not saved. */
  error: string | null;
}

export interface MenuUploadPreview {
  /** Passed back to commit; the main process keeps the checked rows, the screen never sends item data. */
  token: string;
  fileName: string;
  totalRows: number;
  counts: { new: number; update: number; unchanged: number; error: number };
  rows: MenuUploadRow[];
  /** Categories in the file that do not exist yet. */
  newCategories: string[];
  /** Items on the menu that are not in the file (they are left as they are). */
  missingItems: Array<{ name: string; category: string }>;
}

export type MenuUploadPickResult =
  | { status: 'cancelled' }
  /** Problem with the whole file (wrong type, missing column, empty, too many rows). */
  | { status: 'error'; message: string }
  | { status: 'ok'; preview: MenuUploadPreview };

export interface MenuUploadSummary {
  created: number;
  updated: number;
  categoriesCreated: number;
  /** Rows with errors that were left out. */
  skippedErrors: number;
}

/** One upload in the history (Recent uploads): only items that were created or updated are in the log. */
export interface MenuUploadLogBatch {
  batchId: string;
  uploadedAt: string;
  uploadedByName: string | null;
  fileName: string | null;
  created: number;
  updated: number;
  items: Array<{ name: string; category: string; action: 'created' | 'updated'; changes: MenuUploadChange[] }>;
}

export type MenuUploadFileResult = ExportResult;
