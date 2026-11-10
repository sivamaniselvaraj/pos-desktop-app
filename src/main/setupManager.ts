import { app } from 'electron';
import { db } from './data';
import { saveConnection, validateConnectionInput } from './connectionSetup';
import type { ConnectionSetupInput, ConnectionSetupResult } from '../shared/connectionTypes';

/**
 * setupManager.ts
 * ---------------------------------------------------------------------------
 * Saves the setup screen (database URL, auth token, outlet id). Checks the URL
 * and token against the database first unless the user chose "Save without
 * checking", then restarts the app so every part (database clients, menu cache,
 * KOT reconciliation, phone API) starts with the new values.
 * See docs/CONNECTION_SETUP.md.
 * ---------------------------------------------------------------------------
 */
export async function saveConnectionSetup(input: ConnectionSetupInput): Promise<ConnectionSetupResult> {
  const checked = validateConnectionInput(input);
  if (!checked.ok) return { success: false, error: checked.error };
  const { value } = checked;

  if (!input.skipCheck) {
    const problem = await db.checkConnection(value.databaseUrl, value.authToken);
    if (problem) return { success: false, error: problem, checkFailed: true };
  }

  try {
    saveConnection(value);
  } catch (err) {
    console.error('Failed to save connection setup:', err instanceof Error ? err.message : err);
    return { success: false, error: 'Could not save the settings file. Check that the app data folder is writable.' };
  }

  // Let the reply reach the window, then start again with the new values.
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 800);
  return { success: true };
}
