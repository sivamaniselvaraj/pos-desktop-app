/**
 * Checks a Supabase URL and anon key before the setup screen saves them. Asks
 * the Auth service for its public settings, which needs a valid key but no
 * sign-in. Never logs the key.
 */
export async function checkConnection(url: string, token: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/settings`, {
      headers: { apikey: token, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return 'Could not reach the database URL. Check the address and the internet connection.';
  }
  if (res.ok) return null;
  if (res.status === 401 || res.status === 403) {
    return 'The database rejected the auth token. Copy the public API key again from the database service.';
  }
  if (res.status === 404) {
    return 'That URL answered, but it does not look like the database service URL.';
  }
  return `The database answered with an error (HTTP ${res.status}).`;
}
