import { app, BrowserWindow } from 'electron';
import path, { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { startHttpServer, stopHttpServer } from './httpServer';
import { registerIpcHandlers } from './ipcHandlers';

// Minimal .env.local loader (avoids an extra dependency).
function loadEnv(): void {
  const envPath = join(app.getAppPath(), '.env.local');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
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
    title: 'Food Order Printer',
    webPreferences: {
      preload: path.join(__dirname, '../preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload is bundled (esbuild), so it needs no local requires
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    //mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(join(__dirname, '../../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  loadEnv();
  registerIpcHandlers(() => mainWindow);

  try {
    await startHttpServer();
  } catch (err) {
    console.error('Failed to start HTTP server:', err);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopHttpServer();
  if (process.platform !== 'darwin') app.quit();
});
