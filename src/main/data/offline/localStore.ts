/**
 * data/offline/localStore.ts
 * ---------------------------------------------------------------------------
 * The local database on this computer (offline mode, docs/OFFLINE_MODE.md).
 * An encrypted SQLite file (SQLCipher format) in the app's data folder that
 * holds a copy of THIS outlet's data only, so the app can keep working when
 * the internet is down.
 *
 * Phase 1 keeps tier A, the reference data (menu, categories, tax rates,
 * tables, kitchen steps, discount presets, receipt text, the signed-in user's
 * profile and permissions), as snapshots: one row per read, the whole answer
 * as JSON plus a hash, so a refresh only writes when something changed.
 *
 * This file knows nothing about Electron: the folder and the key come in
 * through LocalStoreOptions, so it can be tested with plain Node.
 *
 * Safety:
 *  - WAL journal with synchronous=FULL: a power cut cannot corrupt the file.
 *  - quick_check on open; a broken or unreadable file is moved aside (never
 *    deleted) and the newest good backup is used, else a fresh file.
 *  - A rolling daily backup copy, 7 kept.
 *  - Bound to one outlet: the first outlet that uses it. Another outlet wipes
 *    the copied data before anything is written for it, so one outlet's data
 *    is never readable in another outlet's session.
 * ---------------------------------------------------------------------------
 */
import { createHash } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statfsSync, unlinkSync } from 'fs';
import { join } from 'path';
import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

type SqliteDatabase = BetterSqlite3.Database;
type SqliteCtor = typeof BetterSqlite3;

export const LOCAL_STORE_FILE = 'local-store.db';
export const BACKUP_DIR = 'local-store-backups';
export const BACKUPS_KEPT = 7;
/** Below this much free disk space the status shows a warning. */
export const LOW_DISK_BYTES = 500 * 1024 * 1024;

export interface LocalStoreOptions {
  /** Folder for the file and its backups (userData in the app). */
  dir: string;
  /**
   * The encryption key (hex), created on first use and kept by the caller
   * (encrypted by the OS keychain in the app). null = store unencrypted, only
   * where the OS offers no keychain.
   */
  key: string | null;
  /** Override the SQLite driver (tests). Default: require('better-sqlite3-multiple-ciphers'). */
  driver?: SqliteCtor;
  /** Clock (tests). */
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface SnapshotRow {
  key: string;
  payload: unknown;
  hash: string;
  fetchedAt: string;
  checkedAt: string;
}

export interface LocalStoreInfo {
  path: string;
  encrypted: boolean;
  outletId: string | null;
  snapshotCount: number;
  /** Most recent time any snapshot was confirmed against the database. */
  lastRefreshedAt: string | null;
  lastBackupAt: string | null;
  freeBytes: number | null;
  lowDisk: boolean;
  /** Set when the file had to be replaced on open (moved aside, restored, recreated). */
  recovered: string | null;
}

/** Schema migrations, applied in order; PRAGMA user_version is the count applied. */
const MIGRATIONS: string[] = [
  `create table meta (key text primary key, value text not null);
   create table snapshots (
     key        text primary key,
     repo       text not null,
     method     text not null,
     scope      text not null,
     hash       text not null,
     payload    text not null,
     fetched_at text not null,
     checked_at text not null
   );
   create index snapshots_scope on snapshots(scope);`,
];

/** checked_at is only rewritten when older than this, so a busy read does not write on every call. */
const CHECKED_AT_MIN_GAP_MS = 60_000;

export function hashPayload(json: string): string {
  return createHash('sha256').update(json).digest('hex');
}

function loadDriver(): SqliteCtor {
  // Loaded lazily: when the native module is missing (an unsupported Windows
  // build, a broken install) the app still runs online, without offline mode.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('better-sqlite3-multiple-ciphers') as SqliteCtor;
}

export class LocalStore {
  readonly path: string;
  readonly encrypted: boolean;
  private db: SqliteDatabase;
  private boundOutlet: string | null;
  private recovered: string | null = null;
  private lastBackupAt: string | null = null;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;
  private readonly Driver: SqliteCtor;

  constructor(private readonly opts: LocalStoreOptions) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((m) => console.log(`[localStore] ${m}`));
    this.Driver = opts.driver ?? loadDriver();
    mkdirSync(opts.dir, { recursive: true });
    this.path = join(opts.dir, LOCAL_STORE_FILE);
    this.encrypted = Boolean(opts.key);
    this.db = this.openWithRecovery();
    this.boundOutlet = this.getMeta('outlet_id');
  }

  // -------------------------------------------------------------------------
  // Opening, checking, recovering
  // -------------------------------------------------------------------------
  private openFile(file: string): SqliteDatabase {
    const db = new this.Driver(file);
    try {
      if (this.opts.key) {
        db.pragma(`cipher='sqlcipher'`);
        db.pragma(`key='${this.opts.key.replace(/'/g, "''")}'`);
      }
      // Reading the schema fails here ("file is not a database") when the key is wrong.
      const check = db.pragma('quick_check', { simple: true });
      if (check !== 'ok') throw new Error(`integrity check failed: ${String(check)}`);
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      db.pragma('foreign_keys = ON');
      this.migrate(db);
      return db;
    } catch (err) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  private migrate(db: SqliteDatabase): void {
    const current = Number(db.pragma('user_version', { simple: true })) || 0;
    if (current > MIGRATIONS.length) {
      throw new Error(`the local database is from a newer app version (schema ${current})`);
    }
    for (let v = current; v < MIGRATIONS.length; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v]);
        db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  /** Opens the file; a broken one is moved aside and the newest good backup (or a fresh file) takes its place. */
  private openWithRecovery(): SqliteDatabase {
    try {
      return this.openFile(this.path);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (!existsSync(this.path)) throw err; // could not even create it: let the caller report it
      const aside = this.moveAside(reason);
      for (const backup of this.listBackups()) {
        try {
          copyFileSync(join(this.backupDir(), backup), this.path);
          const db = this.openFile(this.path);
          this.recovered = `The local database could not be opened (${reason}). It was moved to ${aside} and the backup ${backup} was restored.`;
          this.log(this.recovered);
          return db;
        } catch {
          this.removeFileSet(this.path);
        }
      }
      const db = this.openFile(this.path);
      this.recovered = `The local database could not be opened (${reason}). It was moved to ${aside} and a new one was created; it fills again from the database when online.`;
      this.log(this.recovered);
      return db;
    }
  }

  private moveAside(reason: string): string {
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    const target = `${this.path}.broken-${stamp}`;
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(this.path + suffix)) renameSync(this.path + suffix, target + suffix);
    }
    this.log(`moved the local database aside (${reason}) to ${target}`);
    return target;
  }

  private removeFileSet(file: string): void {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        if (existsSync(file + suffix)) unlinkSync(file + suffix);
      } catch {
        /* ignore */
      }
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // Meta and outlet binding
  // -------------------------------------------------------------------------
  getMeta(key: string): string | null {
    const row = this.db.prepare('select value from meta where key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, value);
  }

  get outletId(): string | null {
    return this.boundOutlet;
  }

  /**
   * Makes this file belong to `outletId`. The first outlet binds it; a
   * different outlet wipes every copied row first (phase 1 holds only data
   * that can be fetched again). Returns true when data was wiped.
   */
  bindOutlet(outletId: string): boolean {
    if (!outletId) throw new Error('An outlet id is needed to use the local database.');
    if (this.boundOutlet === outletId) return false;
    const wiped = this.boundOutlet !== null;
    this.db.transaction(() => {
      if (wiped) this.db.prepare('delete from snapshots').run();
      this.setMeta('outlet_id', outletId);
      this.setMeta('outlet_bound_at', this.now().toISOString());
    })();
    if (wiped) this.log(`outlet changed from ${this.boundOutlet} to ${outletId}: the local copy was cleared`);
    this.boundOutlet = outletId;
    return wiped;
  }

  // -------------------------------------------------------------------------
  // Snapshots (tier A reference data)
  // -------------------------------------------------------------------------
  /**
   * Saves the answer of a read. Writes only when the content changed (by
   * hash); otherwise just notes that it was confirmed. Returns true when the
   * content changed.
   */
  putSnapshot(outletId: string, key: string, parts: { repo: string; method: string; scope: string }, payload: unknown): boolean {
    this.bindOutlet(outletId);
    const json = JSON.stringify(payload ?? null);
    const hash = hashPayload(json);
    const nowIso = this.now().toISOString();
    const existing = this.db.prepare('select hash, checked_at from snapshots where key = ?').get(key) as
      | { hash: string; checked_at: string }
      | undefined;
    if (existing && existing.hash === hash) {
      if (this.now().getTime() - Date.parse(existing.checked_at) >= CHECKED_AT_MIN_GAP_MS) {
        this.db.prepare('update snapshots set checked_at = ? where key = ?').run(nowIso, key);
      }
      return false;
    }
    this.db
      .prepare(
        `insert into snapshots(key, repo, method, scope, hash, payload, fetched_at, checked_at)
         values (@key, @repo, @method, @scope, @hash, @payload, @now, @now)
         on conflict(key) do update set hash = excluded.hash, payload = excluded.payload,
           fetched_at = excluded.fetched_at, checked_at = excluded.checked_at`,
      )
      .run({ key, repo: parts.repo, method: parts.method, scope: parts.scope, hash, payload: json, now: nowIso });
    return true;
  }

  /** The saved answer of a read, or null. Never returns another outlet's data. */
  getSnapshot(outletId: string, key: string): SnapshotRow | null {
    if (!outletId || this.boundOutlet !== outletId) return null;
    const row = this.db.prepare('select key, hash, payload, fetched_at, checked_at from snapshots where key = ?').get(key) as
      | { key: string; hash: string; payload: string; fetched_at: string; checked_at: string }
      | undefined;
    if (!row) return null;
    return { key: row.key, hash: row.hash, payload: JSON.parse(row.payload), fetchedAt: row.fetched_at, checkedAt: row.checked_at };
  }

  deleteSnapshot(key: string): void {
    this.db.prepare('delete from snapshots where key = ?').run(key);
  }

  // -------------------------------------------------------------------------
  // Backups and status
  // -------------------------------------------------------------------------
  private backupDir(): string {
    return join(this.opts.dir, BACKUP_DIR);
  }

  /** Backup file names, newest first. */
  listBackups(): string[] {
    const dir = this.backupDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => /^local-store-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort()
      .reverse();
  }

  /**
   * Today's backup copy, once a day; keeps the newest BACKUPS_KEPT. The file
   * is copied as it is on disk, so the copy is encrypted too. Returns the
   * file name written, or null when today's copy already exists.
   */
  backupIfDue(): string | null {
    const day = this.now().toISOString().slice(0, 10);
    const name = `local-store-${day}.db`;
    const dir = this.backupDir();
    mkdirSync(dir, { recursive: true });
    if (existsSync(join(dir, name))) {
      this.lastBackupAt = this.lastBackupAt ?? day;
      return null;
    }
    // Moves everything from the WAL into the main file, so one file is a whole copy.
    // better-sqlite3 is synchronous: nothing writes between the checkpoint and the copy.
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    const tmp = join(dir, `${name}.part`);
    copyFileSync(this.path, tmp);
    renameSync(tmp, join(dir, name));
    for (const old of this.listBackups().slice(BACKUPS_KEPT)) {
      try {
        unlinkSync(join(dir, old));
      } catch {
        /* ignore */
      }
    }
    this.lastBackupAt = this.now().toISOString();
    this.log(`backup written: ${name}`);
    return name;
  }

  freeBytes(): number | null {
    try {
      const s = statfsSync(this.opts.dir);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return null;
    }
  }

  info(): LocalStoreInfo {
    const row = this.db.prepare('select count(*) as n, max(checked_at) as last from snapshots').get() as {
      n: number;
      last: string | null;
    };
    const free = this.freeBytes();
    return {
      path: this.path,
      encrypted: this.encrypted,
      outletId: this.boundOutlet,
      snapshotCount: row.n,
      lastRefreshedAt: row.last,
      lastBackupAt: this.lastBackupAt ?? this.listBackups()[0]?.slice(12, 22) ?? null,
      freeBytes: free,
      lowDisk: free !== null && free < LOW_DISK_BYTES,
      recovered: this.recovered,
    };
  }
}
