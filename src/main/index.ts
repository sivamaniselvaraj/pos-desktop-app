import { app, BrowserWindow, Menu } from 'electron';
import path, { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { startHttpServer, stopHttpServer } from './httpServer';
import { registerIpcHandlers } from './ipcHandlers';
import { startKotReconciliation, stopKotReconciliation } from './kotReconciliation';
import { startMenuCache, stopMenuCache } from './menuCache';
/**
 * Where .env.local lives depends on dev vs packaged:
 *  - Dev: app.getAppPath() resolves to the project root (next to
 *    package.json) — correct, that's where a developer's .env.local sits.
 *  - Packaged: app.getAppPath() resolves INSIDE the read-only app.asar
 *    archive, which never contains .env.local (a secrets file that must
 *    never be bundled into the distributed app). Using that path silently
 *    finds nothing. Use the per-OS user data directory instead — the same
 *    writable, non-privileged location already used for the encrypted auth
 *    session and local printer settings.
 *
 *    Windows: %APPDATA%\Food Order Printer\.env.local
 *    macOS:   ~/Library/Application Support/Food Order Printer/.env.local
 *    Linux:   ~/.config/Food Order Printer/.env.local
 */
function resolveEnvPath(): string {
  const dir = app.isPackaged ? app.getPath('userData') : app.getAppPath();
  return join(dir, '.env.local');
}

// Minimal .env.local loader (avoids an extra dependency).
function loadEnv(): void {
  const envPath = resolveEnvPath();
  console.log(`Loading config from: ${envPath}`);

  if (!existsSync(envPath)) {
    console.warn(
      `.env.local not found at ${envPath} — using defaults/environment variables only. ` +
        (app.isPackaged
          ? 'For a packaged/installed build, place .env.local in the app data folder shown above.'
          : ''),
    );
    return;
  }

  let content: string;
  try {
    content = readFileSync(envPath, 'utf8');
  } catch (err) {
    // Surface real read failures (permissions, locked file, etc.) instead of
    // silently continuing with no config, which looks identical to "file
    // doesn't exist" and is much harder to diagnose.
    console.error(`Found ${envPath} but could not read it:`, err);
    return;
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    // `key in process.env` checks KEY PRESENCE, not whether it holds a real
    // value — if some other source (OS/shell, a launcher script, an empty
    // exported placeholder) already put an EMPTY string there, `in` is still
    // true and this would silently refuse to fill it from .env.local,
    // leaving config.ts's getters reading '' forever regardless of what
    // .env.local actually says. Check truthiness instead: an OS env var only
    // wins if it actually has a value; empty/missing both defer to the file.
    if (!process.env[key]) process.env[key] = value;
  }
}

let mainWindow: BrowserWindow | null = null;
const isDev = process.env.NODE_ENV === 'development';

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Virunthagam',
        // No File/Edit/View/Window/Help menu bar — Menu.setApplicationMenu(null)
    // below removes it entirely, this is a Windows/Linux-only backstop in
    // case something ever re-adds a default menu (falls back to "hidden
    // until Alt is pressed" rather than always-visible, which is still far
    // closer to "no menu" than the default). The native title bar itself
    // (minimize/maximize/close) is untouched — this only affects the menu
    // bar underneath it, not the window frame.
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload is bundled (esbuild), so it needs no local requires
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(join(__dirname, '../../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  loadEnv();
  Menu.setApplicationMenu(null);
    // Load settings from local config
  const { loadSettings } = await import('./settingsManager.js');
  await loadSettings();
  registerIpcHandlers(() => mainWindow);

  try {
    await startHttpServer();
  } catch (err) {
    console.error('Failed to start HTTP server:', err);
  }
  // Runs once now, then every 30s — catches any order whose KOT never made
  // it to the printer because the app was down when it should have fired.
  // See kotReconciliation.ts for the full design and its constraints.
  startKotReconciliation();
    // Populates the in-memory menu cache now, then refreshes every 5 minutes.
    // See menuCache.ts.
  startMenuCache();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopHttpServer();
  stopKotReconciliation();
  stopMenuCache();
  if (process.platform !== 'darwin') app.quit();
});
