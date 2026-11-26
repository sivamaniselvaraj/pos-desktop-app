// Small helpers shared by the phone API route files (docs/API.md).
import type express from 'express';

/** A database id (uuid). */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The answer for an unexpected failure: 503 when the desktop is signed out, else 500. Logged as "[api] tables failed" (its first users were the table routes). */
export function tablesError(err: unknown, res: express.Response): void {
  console.error('[api] tables failed:', err);
  if (/JWT|Not authenticated|not signed in|session/i.test(err instanceof Error ? err.message : '')) {
    res.status(503).json({ error: 'The desktop app is signed out. Sign in on the desktop and try again.' });
    return;
  }
  res.status(500).json({ error: 'The server could not process the request.' });
}
