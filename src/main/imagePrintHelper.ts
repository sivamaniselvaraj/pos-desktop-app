import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import net from 'net';
import path from 'path';
import { promisify } from 'util';
import { app, BrowserWindow } from 'electron';
import { config } from './config';
import { PAPER_MM } from './htmlPrintHelper';
import { getPrinters } from './printerManager';
import { PrintTimeoutError, withTimeout } from './printQueueManager';

/**
 * imagePrint.ts
 * ---------------------------------------------------------------------------
 * "Image (ESC/POS)" print method: the same HTML bill / KOT as the HTML method
 * is drawn in a hidden window, captured as a picture, turned into black and
 * white dots and sent to the printer as an ESC/POS bit image (GS v 0), with
 * the cut command at the end.
 *
 * Why: the page reaches the printer as dots, so Tamil (or any language), the
 * ₹ sign and the layout print exactly as drawn, and the Windows driver's paper
 * size, margins and scaling play no part (the HTML method printed blank strips
 * when they did not match). No native module is needed either:
 *
 * - If the printer has a network address in Settings, the bytes go straight to
 *   it over TCP (port 9100 unless given), skipping Windows completely.
 * - Otherwise they go to the installed Windows printer as a RAW job through
 *   winspool.drv, called from PowerShell (the printer name and data file are
 *   passed as environment variables, never pasted into the command). macOS /
 *   Linux use `lp -o raw`.
 *
 * See docs/IMAGE_PRINT.md.
 * ---------------------------------------------------------------------------
 */

const execFileAsync = promisify(execFile);

/** Dots across the paper: 72 mm at 203 dpi (8 dots per mm). */
const DOTS = 576;
const CSS_PX_PER_MM = 96 / 25.4;
/** Zoom so the 72 mm page (about 272 CSS px) fills exactly DOTS pixels. A function,
 *  not a constant: htmlPrint and this file import each other (via printerManager),
 *  so PAPER_MM may not be set yet while this module loads. */
const zoom = () => DOTS / (PAPER_MM * CSS_PX_PER_MM);
/** Height of one captured slice, in device pixels. */
const SLICE = 1000;
/** Longest ticket we print (about 1.5 m). */
const MAX_DOTS = 12_000;
/** Pixels darker than this (0-255) print black. */
const THRESHOLD = 160;
/** Rows per GS v 0 command; small bands suit printers with little buffer. */
const BAND_ROWS = 128;
const JOB_TIMEOUT_MS = 30_000;
const TCP_TIMEOUT_MS = 10_000;
const DEFAULT_PORT = 9100;
const GAP_MS = 500;

// ---- Network addresses (per printer, printerSetups.ts) ----------------------

function parseAddress(addr: string): { host: string; port: number } {
  const [host, port] = addr.split(':');
  const p = port ? Number(port) : DEFAULT_PORT;
  if (!host || !Number.isInteger(p) || p < 1 || p > 65535)
    throw new Error(`Bad printer address "${addr}".`);
  return { host, port: p };
}

// ---- Queue -------------------------------------------------------------------

let chain: Promise<void> = Promise.resolve();

/** Where an image job goes: straight to `address` when set, else the OS printer `device`. */
export interface ImageTarget {
  /** Used in messages. */
  label: string;
  device: string;
  address: string;
}

/** Print an HTML page as an ESC/POS bit image (queued, one job at a time). */
export function printImage(html: string, target: ImageTarget): Promise<void> {
  const job = chain.then(() => printImageNow(html, target));
  chain = job.then(
    () => new Promise<void>((r) => setTimeout(r, GAP_MS)),
    () => new Promise<void>((r) => setTimeout(r, GAP_MS)),
  );
  return job;
}

async function printImageNow(html: string, target: ImageTarget): Promise<void> {
  const name = (target.device ?? '').trim();
  const address = (target.address ?? '').trim();
  const label = (target.label || name || address).trim();
  if (!name && !address) throw new Error('No printer selected.');
  try {
    await withTimeout(
      (async () => {
        const bytes = toEscPos(await renderToDots(html));
        if (address) await sendTcp(address, bytes);
        else await sendSpooler(name, bytes);
      })(),
      JOB_TIMEOUT_MS,
      `Image print to "${label}"`,
    );
  } catch (err) {
    if (err instanceof PrintTimeoutError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Image print to "${label}"${address && address !== label ? ` (${address})` : ''} failed: ${msg}`);
  }
}

// ---- HTML -> black and white dots ----------------------------------------------

interface Dots {
  width: number;
  height: number;
  /** 1 bit per dot, rows of width/8 bytes, MSB = leftmost, 1 = black. */
  data: Buffer;
}

let jobFile: string | null = null;

async function writeJobFile(html: string): Promise<string> {
  if (!jobFile) {
    const dir = path.join(app.getPath('temp'), 'virunthagam-pos-print');
    await fs.mkdir(dir, { recursive: true });
    jobFile = path.join(dir, 'image-job.html');
  }
  await fs.writeFile(jobFile, html, 'utf8');
  return jobFile;
}

const PAINTED_JS = `Promise.race([
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))),
  new Promise((r) => setTimeout(() => r(false), 1000)),
])`;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exported for tests. */
export async function renderToDots(html: string): Promise<Dots> {
  // Offscreen: the page is drawn to memory at any size, never on screen.
  // A new window per job (a reused print window failed to load on Windows).
  const win = new BrowserWindow({
    show: false,
    width: DOTS,
    height: SLICE,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
      backgroundThrottling: false,
    },
  });
  const ZOOM = zoom();
  try {
    win.setContentSize(DOTS, SLICE);
    try {
      await win.loadFile(await writeJobFile(html));
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw new Error(
        `could not prepare the page (${/ERR_[A-Z_]+ \(-?\d+\)/.exec(raw)?.[0] ?? raw.slice(0, 120)})`,
      );
    }
    win.webContents.setZoomFactor(ZOOM);
    await win.webContents.executeJavaScript(
      `document.documentElement.style.overflow = 'hidden'; document.body.style.transformOrigin = '0 0'; true`,
    );
    await win.webContents.executeJavaScript(PAINTED_JS);
    await wait(100);

    const cssHeight = (await win.webContents.executeJavaScript(
      'Math.ceil(document.body.getBoundingClientRect().height)',
    )) as number;
    const height = Math.min(MAX_DOTS, Math.max(1, Math.ceil(cssHeight * ZOOM)));
    const rowBytes = DOTS / 8;
    const data = Buffer.alloc(rowBytes * height);

    for (let top = 0; top < height; top += SLICE) {
      const rows = Math.min(SLICE, height - top);
      // Move the page up instead of scrolling: no scroll limits, exact offsets.
      await win.webContents.executeJavaScript(
        `document.body.style.transform = 'translateY(-${top / ZOOM}px)'; true`,
      );
      await win.webContents.executeJavaScript(PAINTED_JS);
      win.webContents.invalidate();
      await wait(60);
      let img = await win.webContents.capturePage({ x: 0, y: 0, width: DOTS, height: rows });
      const size = img.getSize();
      if (size.width !== DOTS || size.height !== rows) {
        img = img.resize({ width: DOTS, height: rows, quality: 'best' });
      }
      // toBitmap() is BGRA (RGBA order does not matter for grey text on white).
      const px = img.toBitmap();
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < DOTS; x++) {
          const i = (y * DOTS + x) * 4;
          const a = px[i + 3];
          const lum = a === 0 ? 255 : (px[i] * 114 + px[i + 1] * 587 + px[i + 2] * 299) / 1000;
          if (lum < THRESHOLD) data[(top + y) * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
    }
    return trimBottom({ width: DOTS, height, data });
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** Drop blank rows at the bottom (keep a few for spacing). */
function trimBottom(d: Dots): Dots {
  const rowBytes = d.width / 8;
  let last = d.height - 1;
  while (last > 0) {
    const row = d.data.subarray(last * rowBytes, (last + 1) * rowBytes);
    if (row.some((b) => b !== 0)) break;
    last--;
  }
  const height = Math.min(d.height, last + 1 + 16);
  return { width: d.width, height, data: d.data.subarray(0, height * rowBytes) };
}

// ---- Dots -> ESC/POS ---------------------------------------------------------------

/** ESC @, the image in GS v 0 bands, feed, partial cut. Exported for tests. */
export function toEscPos(d: Dots): Buffer {
  const rowBytes = d.width / 8;
  const parts: Buffer[] = [Buffer.from([0x1b, 0x40])]; // ESC @ initialise
  for (let top = 0; top < d.height; top += BAND_ROWS) {
    const rows = Math.min(BAND_ROWS, d.height - top);
    parts.push(
      Buffer.from([0x1d, 0x76, 0x30, 0x00, rowBytes & 0xff, rowBytes >> 8, rows & 0xff, rows >> 8]),
      d.data.subarray(top * rowBytes, (top + rows) * rowBytes),
    );
  }
  parts.push(Buffer.from([0x1b, 0x64, 0x04])); // ESC d 4: feed 4 lines
  parts.push(Buffer.from([0x1d, 0x56, 0x42, 0x00])); // GS V 66 0: feed to cutter, partial cut
  return Buffer.concat(parts);
}

// ---- Sending -------------------------------------------------------------------

/** Turn a socket error into a sentence that says what to check. Exported for tests. */
export function describeTcpError(host: string, port: number, code: string | undefined, raw: string): string {
  const check =
    `Check the IP address (hold FEED while switching the printer on to print a self-test page with it), ` +
    `that this PC is on the same network, and that no firewall or antivirus blocks outgoing connections to port ${port}. ` +
    `Test from PowerShell: Test-NetConnection ${host} -Port ${port}`;
  switch (code) {
    case 'ECONNREFUSED':
      return (
        `the printer at ${host} refused the connection on port ${port}. ` +
        `Check the port (most printers use 9100) and that no other program is holding the printer.`
      );
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EHOSTDOWN':
      return `nothing answered at ${host}:${port} (${code}). ${check}.`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `the address "${host}" could not be found. Enter the printer's IP address, for example 192.168.1.50.`;
    default:
      return `could not reach ${host}:${port} (${raw}). ${check}.`;
  }
}

function sendTcp(address: string, bytes: Buffer): Promise<void> {
  const { host, port } = parseAddress(address);
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(TCP_TIMEOUT_MS, () =>
      finish(new Error(describeTcpError(host, port, 'ETIMEDOUT', `no answer within ${TCP_TIMEOUT_MS / 1000} s`))),
    );
    socket.on('error', (err: NodeJS.ErrnoException) =>
      finish(new Error(describeTcpError(host, port, err.code, err.message))),
    );
    socket.on('connect', () => {
      socket.end(bytes, () => finish());
    });
  });
}

// Fixed script: the printer name and data file arrive as environment variables.
//
// Windows can accept a RAW job (WritePrinter succeeds) and then fail it in the
// queue, for example when the printer uses Windows' own network driver (IPP
// class driver, WSD port, v4 driver) that does not take raw printer commands.
// The queue then shows the job as "Deleted, Error" while the app used to report
// success (seen on 2026-11-12 with an RP3200 plus(E)). So after sending, the
// script watches the job for a few seconds and reports an error state, and every
// failure names the printer's driver and port. Messages for the app start with
// "VPOS:" (error, stderr) or "VPOS-WARN:" (stdout).
const RAW_PRINT_PS = String.raw`
$ErrorActionPreference = 'Stop'
$name = $env:VPOS_PRINTER
function Get-VposPrinterInfo {
  try { $p = Get-Printer -Name $name; "driver '" + $p.DriverName + "', port '" + $p.PortName + "'" }
  catch { 'driver and port unknown' }
}
function Fail([string]$msg) {
  [Console]::Error.WriteLine('VPOS: ' + $msg + ' (' + (Get-VposPrinterInfo) + ')')
  exit 1
}
try {
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class VposRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinter(string name, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr h, byte[] b, int count, out int written);
  static Exception Win(string step) {
    int code = Marshal.GetLastWin32Error();
    return new Exception(step + " failed: " + new Win32Exception(code).Message + " (Windows error " + code + ")");
  }
  public static int Send(string name, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(name, out h, IntPtr.Zero)) throw Win("Opening the printer");
    try {
      DOCINFO di = new DOCINFO();
      di.pDocName = "Virunthagam POS";
      di.pDataType = "RAW";
      int job = StartDocPrinter(h, 1, di);
      if (job == 0) throw Win("Starting a raw print job");
      try {
        StartPagePrinter(h);
        int written;
        if (!WritePrinter(h, data, data.Length, out written)) throw Win("Sending the data");
        if (written != data.Length) throw new Exception("Windows took only " + written + " of " + data.Length + " bytes");
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
      return job;
    } finally { ClosePrinter(h); }
  }
}
"@
  $id = [VposRawPrint]::Send($name, [System.IO.File]::ReadAllBytes($env:VPOS_FILE))
} catch {
  $e = $_.Exception
  while ($e.InnerException) { $e = $e.InnerException }
  Fail $e.Message
}

# Watch the job: gone from the queue or "Printed" is success; an error state is a failure.
$deadline = (Get-Date).AddSeconds(8)
$status = ''
while ((Get-Date) -lt $deadline) {
  $j = $null
  try { $j = Get-PrintJob -PrinterName $name -ID $id -ErrorAction Stop } catch { exit 0 }
  if (-not $j) { exit 0 }
  $status = [string]$j.JobStatus
  if ($status -match 'Error|Offline|PaperOut|Blocked|UserIntervention') {
    try { Remove-PrintJob -InputObject $j -ErrorAction SilentlyContinue } catch {}
    Fail ("Windows accepted the job but marked it '" + $status + "' in the print queue, so the printer did not take it")
  }
  if ($status -match 'Printed|Complete') { exit 0 }
  Start-Sleep -Milliseconds 300
}
Write-Output ('VPOS-WARN: job ' + $id + ' still in the Windows queue after 8 s (status ''' + $status + '''; ' + (Get-VposPrinterInfo) + ')')
`;

/** What to try when Windows will not print a raw job. */
const SPOOLER_HINT =
  'The printer\'s Windows driver or port does not accept raw printer commands. Usually Windows set the printer up ' +
  'with its own network driver ("IPP Class Driver" or a "WSD" port). Fix: enter the printer\'s IP address in ' +
  'Settings > Printers (Image method), so the app sends to the printer directly, or install the maker\'s driver ' +
  'with a "Standard TCP/IP" port.';

/** Build the user-facing message from a failed PowerShell run. Exported for tests. */
export function describeSpoolerFailure(err: {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  code?: number | string | null;
  killed?: boolean;
  signal?: string | null;
}): string {
  if (err.killed || err.signal) return 'Windows did not take the job within 25 s. Check the printer is on and not paused in Windows.';
  const out = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
  const vpos = /VPOS: ([^\r\n]+)/.exec(out)?.[1]?.trim();
  if (vpos) return `Windows did not print it. ${vpos}. ${SPOOLER_HINT}`;
  // Anything else: the first stderr line, never execFile's "Command failed: <whole command>".
  const line = String(err.stderr ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#< CLIXML'));
  return `PowerShell could not send the job to Windows (${(line ?? `exit code ${err.code ?? '?'}`).slice(0, 200)}).`;
}

/** -EncodedCommand: base64 of UTF-16LE. Avoids quoting the script through the Windows command line. */
const encodePowerShell = (script: string) => Buffer.from(script, 'utf16le').toString('base64');

async function sendSpooler(name: string, bytes: Buffer): Promise<void> {
  const known =
    (await getPrinters()).some((p) => p.name === name) ||
    (await getPrinters(true)).some((p) => p.name === name);
  if (!known)
    throw new Error(
      `printer "${name}" was not found in the OS. Check it is installed, or enter its network address.`,
    );

  const dir = path.join(app.getPath('temp'), 'virunthagam-pos-print');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'image-job.bin');
  await fs.writeFile(file, bytes);

  if (process.platform !== 'win32') {
    try {
      await execFileAsync('lp', ['-d', name, '-o', 'raw', file], { timeout: 25_000 });
    } catch (err) {
      const e = err as { stderr?: string };
      throw new Error(`lp refused the job (${String(e.stderr ?? err).trim().slice(0, 200)}).`);
    }
    return;
  }

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(RAW_PRINT_PS)],
      {
        env: { ...process.env, VPOS_PRINTER: name, VPOS_FILE: file },
        windowsHide: true,
        timeout: 25_000,
      },
    );
    const warn = /VPOS-WARN: ([^\r\n]+)/.exec(stdout)?.[1];
    if (warn) console.warn(`[imagePrint] ${name}: ${warn}`);
  } catch (err) {
    const msg = describeSpoolerFailure(err as Parameters<typeof describeSpoolerFailure>[0]);
    console.warn(`[imagePrint] ${name}: ${msg}`);
    throw new Error(msg);
  }
}
