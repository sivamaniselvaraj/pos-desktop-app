/**
 * logger.ts
 * ---------------------------------------------------------------------------
 * File logging for the installed app, where nobody can see the console.
 *
 *  - main.log: everything the main process writes with console.log / info /
 *    warn / error, with a timestamp and level. initLogging() tees the console
 *    into the file, so the existing console.* calls need no change.
 *  - print-journal.log: one JSON line per print job (bill, KOT, test print):
 *    time, job kind, order, printer, print method, result, milliseconds and
 *    the error message. Use it to answer "did the 8:40 KOT for table 5 print?"
 *    after the fact.
 *
 * Both live in the app's logs folder (Windows: %APPDATA%\Virunthagam POS\logs).
 * Each file rotates at MAX_BYTES: main.log -> main.1.log -> main.2.log, and the
 * oldest is deleted, so the folder stays under about 20 MB.
 *
 * No dependency: plain fs append streams. A logging failure never throws into
 * the caller; it falls back to the console only.
 * ---------------------------------------------------------------------------
 */
import { app } from 'electron';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from 'fs';
import { join } from 'path';
import { format } from 'util';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB per file
const KEEP_OLD = 2; // main.1.log, main.2.log

class RotatingFile {
  private stream: WriteStream | null = null;
  private bytes = 0;

  constructor(
    private readonly dir: string,
    private readonly base: string, // e.g. 'main' -> main.log
  ) {}

  private path(index = 0): string {
    return join(this.dir, index === 0 ? `${this.base}.log` : `${this.base}.${index}.log`);
  }

  private open(): WriteStream {
    if (!this.stream) {
      const current = this.path();
      this.bytes = existsSync(current) ? statSync(current).size : 0;
      this.stream = createWriteStream(current, { flags: 'a' });
      this.stream.on('error', () => {
        // Disk full, folder removed, etc. Drop the stream; the next write tries again.
        this.stream = null;
      });
    }
    return this.stream;
  }

  private rotate(): void {
    this.stream?.end();
    this.stream = null;
    try {
      const oldest = this.path(KEEP_OLD);
      if (existsSync(oldest)) unlinkSync(oldest);
      for (let i = KEEP_OLD - 1; i >= 0; i--) {
        if (existsSync(this.path(i))) renameSync(this.path(i), this.path(i + 1));
      }
    } catch {
      // A locked file (antivirus, an open editor) only delays rotation.
    }
    this.bytes = 0;
  }

  write(line: string): void {
    try {
      if (this.bytes >= MAX_BYTES) this.rotate();
      const data = line.endsWith('\n') ? line : `${line}\n`;
      this.open().write(data);
      this.bytes += Buffer.byteLength(data);
    } catch {
      // Never let logging break the app.
    }
  }
}

let logsDir: string | null = null;
let mainLog: RotatingFile | null = null;
let journal: RotatingFile | null = null;

/** The folder holding main.log and print-journal.log (null before initLogging). */
export function getLogsDir(): string | null {
  return logsDir;
}

/**
 * Tee console.* into main.log. Call once, as early as possible in index.ts.
 * Safe to call again (does nothing the second time).
 */
export function initLogging(): void {
  if (mainLog) return;
  try {
    app.setAppLogsPath(); // default: <userData>/logs on Windows and Linux, ~/Library/Logs/<name> on macOS
    logsDir = app.getPath('logs');
    mkdirSync(logsDir, { recursive: true });
  } catch (err) {
    console.error('[logger] Log folder unavailable; logging to the console only:', err);
    return;
  }
  mainLog = new RotatingFile(logsDir, 'main');
  journal = new RotatingFile(logsDir, 'print-journal');

  const levels = ['log', 'info', 'warn', 'error'] as const;
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      mainLog?.write(
        `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${format(...args)}`,
      );
    };
  }
  console.log(`[logger] Logging to ${logsDir} (app ${app.getVersion()})`);
}

export interface PrintJournalEntry {
  job: 'bill' | 'kot' | 'test';
  printer: string;
  method: 'direct' | 'html';
  ok: boolean;
  ms: number;
  orderId?: string;
  orderNumber?: number;
  orderNumbers?: number[];
  items?: number;
  duplicate?: boolean;
  error?: string;
}

/** Append one line to print-journal.log (and nothing if logging is not set up). */
export function recordPrintJob(entry: PrintJournalEntry): void {
  journal?.write(JSON.stringify({ at: new Date().toISOString(), ...entry }));
}

/**
 * Run a print and record it in the journal, whether it succeeds or throws.
 * The print's own result or error passes through unchanged.
 */
export async function journalPrint<T>(
  details: Omit<PrintJournalEntry, 'ok' | 'ms' | 'error'>,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await run();
    recordPrintJob({ ...details, ok: true, ms: Date.now() - started });
    return result;
  } catch (err) {
    recordPrintJob({
      ...details,
      ok: false,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
