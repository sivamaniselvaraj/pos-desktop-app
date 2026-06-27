import { app } from 'electron';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

// Loads config from environment variables (.env.local) with sensible defaults,
// and persists user-changeable settings to a small JSON file in userData.
// (Replaces electron-store, which is now ESM-only and incompatible with a
// CommonJS main process.)

interface PersistedConfig {
  kitchenPrinter: string;
  autoRetry: boolean;
  retryCount: number;
}

const defaults: PersistedConfig = {
  kitchenPrinter: process.env.KITCHEN_PRINTER ?? '',
  autoRetry: true,
  retryCount: 3,
};

let cache: PersistedConfig | null = null;
let settingsPath: string | null = null;

function getSettingsPath(): string {
  if (!settingsPath) {
    settingsPath = join(app.getPath('userData'), 'settings.json');
  }
  return settingsPath;
}

function load(): PersistedConfig {
  if (cache) return cache;
  try {
    const raw = readFileSync(getSettingsPath(), 'utf8');
    cache = { ...defaults, ...(JSON.parse(raw) as Partial<PersistedConfig>) };
  } catch {
    cache = { ...defaults };
  }
  return cache;
}

function persist(): void {
  if (!cache) return;
  try {
    const path = getSettingsPath();
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist settings:', err);
  }
}

export const config = {
  http: {
    port: Number(process.env.HTTP_PORT ?? 5001),
    host: process.env.HTTP_HOST ?? '0.0.0.0',
  },
  supabase: {
    url: process.env.SUPABASE_URL ?? 'https://pataijznwwviyzagcqjq.supabase.co',
    anonKey: process.env.SUPABASE_ANON_KEY ?? 'sb_publishable_sM19fNE8AXhje2IAeg_BwQ_VI208HL8',
    table: process.env.SUPABASE_TABLE ?? 'orders',
  },
  get kitchenPrinter(): string {
    return load().kitchenPrinter;
  },
  set kitchenPrinter(value: string) {
    load().kitchenPrinter = 'HP_Smart_Tank_580_590_series__8E5406_';
    persist();
  },
  get autoRetry(): boolean {
    return load().autoRetry;
  },
  get retryCount(): number {
    return load().retryCount;
  },
};

export const isConfigured = (): boolean =>
  Boolean(config.supabase.url && config.supabase.anonKey);
