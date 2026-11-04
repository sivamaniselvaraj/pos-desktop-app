/**
 * updateManager.ts: app updates (Windows, NSIS installer). See docs/APP_UPDATES.md.
 * ---------------------------------------------------------------------------
 * - Reads <UPDATE_BASE_URL>/win/<x64|ia32>/<stable|beta>/latest.yml from the
 *   Cloudflare R2 bucket (electron-updater's generic provider; no token in the app).
 * - Downloads a newer version in the background, then waits. It never installs
 *   by itself: the cashier presses Install now (banner or About page).
 * - Staged rollout is electron-updater's own `stagingPercentage` in latest.yml.
 * - Release policy: one database row (get_app_release_policy) can block a
 *   version or set a minimum. The last policy read is cached in userData, so an
 *   unreachable server never blocks anyone and never unblocks a blocked PC.
 * - Off when the app is not packaged, not on Windows, or built without
 *   UPDATE_BASE_URL.
 * ---------------------------------------------------------------------------
 */
import { app, BrowserWindow } from 'electron';
import { join } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { autoUpdater, type UpdateInfo } from 'electron-updater';
import { config } from './config';
import { db } from './data';
import { printQueue } from './printQueue';
import { policyBlocks } from './updatePolicy';
import {
  IpcChannels,
  type InstallCheck,
  type ReleasePolicy,
  type UpdateChannel,
  type UpdateStatus,
} from '../shared/types';

const FIRST_CHECK_DELAY_MS = 60_000; // let the app finish starting first
const CHECK_EVERY_MS = 4 * 60 * 60_000; // 4 hours
const POLICY_EVERY_MS = 60 * 60_000; // 1 hour

let getWindow: () => BrowserWindow | null = () => null;
let checkTimer: NodeJS.Timeout | null = null;
let policyTimer: NodeJS.Timeout | null = null;
let firstTimer: NodeJS.Timeout | null = null;
let started = false;
let policy: ReleasePolicy | null = null;

const status: UpdateStatus = {
  phase: 'disabled',
  currentVersion: app.getVersion(),
  channel: 'stable',
  required: false,
};

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function publish(patch: Partial<UpdateStatus>): void {
  Object.assign(status, patch);
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(IpcChannels.UPDATE_STATUS, { ...status });
}

export function getUpdateStatus(): UpdateStatus {
  return { ...status };
}

function notesText(info: UpdateInfo): string | undefined {
  const n = info.releaseNotes;
  if (!n) return undefined;
  if (typeof n === 'string') return n;
  return n.map((x:any) => x.note ?? '').filter(Boolean).join('\n\n') || undefined;
}

function feedUrl(channel: UpdateChannel): string {
  const arch = process.arch === 'ia32' ? 'ia32' : 'x64';
  return `${config.updateBaseUrl}/win/${arch}/${channel}`;
}

// ---------------------------------------------------------------------------
// Release policy (cached in userData/release-policy.json)
// ---------------------------------------------------------------------------

function policyFile(): string {
  return join(app.getPath('userData'), 'release-policy.json');
}

function loadCachedPolicy(): ReleasePolicy | null {
  try {
    return JSON.parse(readFileSync(policyFile(), 'utf8')) as ReleasePolicy;
  } catch {
    return null;
  }
}

function applyPolicy(p: ReleasePolicy | null): void {
  policy = p;
  const why = policyBlocks(status.currentVersion, policy);
  publish({ required: why !== null, requiredMessage: why ?? undefined });
}

/** Reads the policy from the database; keeps the cached one when that fails (offline, signed out). */
export async function refreshPolicy(): Promise<void> {
  try {
    const p = await db.releases.getPolicy();
    const next: ReleasePolicy = p ?? { minimumVersion: null, blockedVersions: [], message: null };
    try {
      writeFileSync(policyFile(), JSON.stringify(next), 'utf8');
    } catch (err) {
      console.warn('[updates] Could not cache the release policy:', err);
    }
    applyPolicy(next);
  } catch (err) {
    console.warn(
      '[updates] Release policy not read; using the cached one:',
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------------------------------------------------------------------------
// Checking and installing
// ---------------------------------------------------------------------------

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (status.phase === 'disabled') return getUpdateStatus();
  void refreshPolicy();
  // Once downloaded, keep the ready version; a new check would only find the same one.
  if (status.phase === 'ready' || status.phase === 'downloading' || status.phase === 'checking') {
    return getUpdateStatus();
  }
  try {
    publish({ phase: 'checking', error: undefined });
    await autoUpdater.checkForUpdates();
  } catch (err) {
    // The 'error' event also fires; this only keeps the rejection from escaping.
    publish({
      phase: 'error',
      error: err instanceof Error ? err.message : String(err),
      lastCheckedAt: new Date().toISOString(),
    });
  }
  return getUpdateStatus();
}

export async function getInstallCheck(): Promise<InstallCheck> {
  let unprintedKots: number | null = null;
  try {
    unprintedKots = (await db.orders.listUnprintedKots()).length;
  } catch (err) {
    console.warn('[updates] Unprinted KOT count not read:', err instanceof Error ? err.message : err);
  }
  return { unprintedKots, printing: printQueue.isProcessing || printQueue.length > 0 };
}

/**
 * Closes the app, runs the downloaded installer silently and reopens the app.
 * Windows asks for permission (UAC) because the app is installed for all users.
 * Nothing is lost: drafts, pending print stamps and settings are already on
 * disk, and KOT reconciliation prints anything left unprinted on the next start.
 */
export function installUpdate(): void {
  if (status.phase !== 'ready') throw new Error('No update has been downloaded yet.');
  console.log(`[updates] Installing ${status.version} (from ${status.currentVersion}).`);
  // Let the IPC reply reach the window before it closes.
  setTimeout(() => autoUpdater.quitAndInstall(true, true), 300);
}

export async function setUpdateChannel(channel: UpdateChannel): Promise<UpdateStatus> {
  const next: UpdateChannel = channel === 'beta' ? 'beta' : 'stable';
  config.updateChannel = next;
  publish({ channel: next });
  if (status.phase === 'disabled') return getUpdateStatus();
  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl(next) });
  if (status.phase !== 'ready' && status.phase !== 'downloading') {
    publish({ phase: 'idle', version: undefined, releaseNotes: undefined, percent: undefined });
    return checkForUpdates();
  }
  return getUpdateStatus();
}

export function startUpdateManager(windowGetter: () => BrowserWindow | null): void {
  if (started) return;
  started = true;
  getWindow = windowGetter;
  status.channel = config.updateChannel;

  // The policy applies even when this build cannot update itself.
  applyPolicy(loadCachedPolicy());
  void refreshPolicy();
  policyTimer = setInterval(() => void refreshPolicy(), POLICY_EVERY_MS);

  const why = !app.isPackaged
    ? 'not a packaged build'
    : process.platform !== 'win32'
      ? 'not Windows'
      : !config.updateBaseUrl
        ? 'UPDATE_BASE_URL was not set when this version was built'
        : null;
  if (why) {
    console.log(`[updates] Auto-update off: ${why}.`);
    publish({ phase: 'disabled' });
    return;
  }

  autoUpdater.logger = {
    info: (m: unknown) => console.log('[updates]', m),
    warn: (m: unknown) => console.warn('[updates]', m),
    error: (m: unknown) => console.error('[updates]', m),
    debug: () => {},
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false; // install only when the cashier says so
  autoUpdater.allowDowngrade = false;
  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl(status.channel) });
  console.log(`[updates] Feed: ${feedUrl(status.channel)}`);

  autoUpdater.on('checking-for-update', () => publish({ phase: 'checking', error: undefined }));
  autoUpdater.on('update-not-available', () =>
    publish({ phase: 'none', lastCheckedAt: new Date().toISOString() }),
  );
  autoUpdater.on('update-available', (info: UpdateInfo) =>
    publish({
      phase: 'downloading',
      version: info.version,
      releaseNotes: notesText(info),
      percent: 0,
      lastCheckedAt: new Date().toISOString(),
    }),
  );
  autoUpdater.on('download-progress', (p: { percent: number }) =>
    publish({ phase: 'downloading', percent: Math.round(p.percent) }),
  );
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    console.log(`[updates] Version ${info.version} downloaded; waiting for Install now.`);
    publish({ phase: 'ready', version: info.version, releaseNotes: notesText(info), percent: 100 });
  });
  autoUpdater.on('error', (err: Error) => {
    console.error('[updates] Update error:', err?.message ?? err);
    // A failed check or download is retried at the next check; a ready version stays ready.
    if (status.phase !== 'ready') {
      publish({ phase: 'error', error: err?.message ?? String(err), lastCheckedAt: new Date().toISOString() });
    }
  });

  publish({ phase: 'idle' });
  firstTimer = setTimeout(() => void checkForUpdates(), FIRST_CHECK_DELAY_MS);
  checkTimer = setInterval(() => void checkForUpdates(), CHECK_EVERY_MS);
}

export function stopUpdateManager(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (checkTimer) clearInterval(checkTimer);
  if (policyTimer) clearInterval(policyTimer);
  firstTimer = checkTimer = policyTimer = null;
}
