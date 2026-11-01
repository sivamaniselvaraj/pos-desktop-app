/**
 * pendingPrintState.ts
 * ---------------------------------------------------------------------------
 * Saves orderManager's "printed on paper, database update still pending"
 * lists to a small JSON file, so they survive an app restart.
 *
 *  - kotStamps: order_items ids whose KOT printed but whose kot_printed stamp
 *    could not be saved. Without this file, a restart would forget them and
 *    the 30 s KOT sweep would print the same ticket again.
 *  - settles: orders ids whose settle bill printed but which could not be
 *    marked completed. Without it, settling again after a restart would print
 *    the bill a second time.
 *
 * The file is pending-print-state.json next to settings.json (the userData
 * folder in an installed app, the project folder in development). It is
 * written atomically (temp file, then rename) on every change. Entries older
 * than MAX_AGE_MS are dropped on load: by then the operator has dealt with
 * the order by hand, and a very old id should not block anything.
 * ---------------------------------------------------------------------------
 */
import { app } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';

const FILE_NAME = 'pending-print-state.json';
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

interface FileShape {
  version: 1;
  /** id -> ISO time it was added */
  kotStamps: Record<string, string>;
  settles: Record<string, string>;
}

let filePath: string | null = null;
function getFilePath(): string {
  if (!filePath) {
    const dir = app.isPackaged ? app.getPath('userData') : app.getAppPath();
    filePath = join(dir, FILE_NAME);
  }
  return filePath;
}

function fresh(entries: Record<string, string> | undefined, now: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, at] of Object.entries(entries ?? {})) {
    const t = Date.parse(at);
    if (typeof id === 'string' && id && Number.isFinite(t) && now - t < MAX_AGE_MS) out.set(id, at);
  }
  return out;
}

/**
 * A Set of ids that writes itself to disk whenever it changes. Only the
 * methods orderManager uses are provided (has, add, delete, size, iterate).
 */
export class PersistentIdSet {
  constructor(
    private readonly items: Map<string, string>,
    private readonly save: () => void,
  ) {}

  get size(): number {
    return this.items.size;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  add(id: string): this {
    if (!this.items.has(id)) {
      this.items.set(id, new Date().toISOString());
      this.save();
    }
    return this;
  }

  delete(id: string): boolean {
    const removed = this.items.delete(id);
    if (removed) this.save();
    return removed;
  }

  [Symbol.iterator](): IterableIterator<string> {
    return this.items.keys();
  }

  /** Internal: the raw entries for saving. */
  entries(): Record<string, string> {
    return Object.fromEntries(this.items);
  }
}

/** Load both lists from disk (empty when the file is missing or unreadable). */
export function loadPendingPrintState(): { kotStamps: PersistentIdSet; settles: PersistentIdSet } {
  let parsed: Partial<FileShape> = {};
  const now = Date.now();
  try {
    const path = getFilePath();
    if (existsSync(path)) parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<FileShape>;
  } catch (err) {
    console.error(
      '[pendingPrintState] Could not read saved pending prints; starting empty:',
      err instanceof Error ? err.message : err,
    );
  }

  // `save` runs only after `sets` below exists (never during construction).
  const save = () => {
    const data: FileShape = {
      version: 1,
      kotStamps: sets.kotStamps.entries(),
      settles: sets.settles.entries(),
    };
    try {
      const path = getFilePath();
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      renameSync(tmp, path);
    } catch (err) {
      console.error(
        '[pendingPrintState] Could not save pending prints:',
        err instanceof Error ? err.message : err,
      );
    }
  };

  const sets = {
    kotStamps: new PersistentIdSet(fresh(parsed.kotStamps, now), save),
    settles: new PersistentIdSet(fresh(parsed.settles, now), save),
  };
  if (sets.kotStamps.size > 0 || sets.settles.size > 0) {
    console.log(
      `[pendingPrintState] Restored ${sets.kotStamps.size} pending KOT stamp(s) and ${sets.settles.size} pending settle(s) from the last run.`,
    );
  }
  return sets;
}
