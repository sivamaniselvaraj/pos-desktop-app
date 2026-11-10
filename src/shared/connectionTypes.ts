// Connection setup types (setup screen; docs/CONNECTION_SETUP.md).
// Shared by the main process and the renderer.

/** Where a connection value came from: the setup screen, an env variable / .env.local, the build, or nowhere. */
export type ConnectionValueSource = 'saved' | 'env' | 'build' | 'none';

export interface ConnectionSetupStatus {
  /** True when the database URL, auth token and outlet id are all set. */
  complete: boolean;
  missing: Array<'databaseUrl' | 'authToken' | 'outletId'>;
  databaseUrl: string;
  databaseUrlSource: ConnectionValueSource;
  /** The token itself never leaves the main process. */
  hasAuthToken: boolean;
  authTokenSource: ConnectionValueSource;
  outletId: string;
  outletIdSource: ConnectionValueSource;
  /** Full path of connection.json on this PC. */
  filePath: string;
  /** False where the OS offers no encryption (the token is then stored as plain text). */
  tokenEncrypted: boolean;
}

export interface ConnectionSetupInput {
  databaseUrl: string;
  /** Empty keeps the token already in use. */
  authToken?: string;
  outletId: string;
  /** Save even if the database could not be reached or rejected the token. */
  skipCheck?: boolean;
}

export interface ConnectionSetupResult {
  success: boolean;
  error?: string;
  /** The values are valid but the database check failed; the UI offers "Save without checking". */
  checkFailed?: boolean;
}

export const ConnectionConfig = {
  "DB_URL": "",
  "DB_KEY": "",
  "DB_ORDERS_TABLE": "",
  "HTTP_PORT": "",
  "HTTP_HOST": "",
  "ALLOWED_ORIGINS": "",
  "UPDATE_BASE_URL": ""
} as const;
