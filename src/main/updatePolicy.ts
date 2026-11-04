/** Version checks for the app release policy (no Electron imports, so they can be tested alone). */
import type { ReleasePolicy } from '../shared/types';

/** Compares "1.2.3" style versions (pre-release tags ignored). <0, 0, >0. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length, 3); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Why the policy requires an update for `version`, or null when it does not. */
export function policyBlocks(version: string, p: ReleasePolicy | null): string | null {
  if (!p) return null;
  const blocked = p.blockedVersions.some((v) => compareVersions(v, version) === 0);
  const tooOld = Boolean(p.minimumVersion) && compareVersions(version, p.minimumVersion!) < 0;
  if (!blocked && !tooOld) return null;
  return (
    p.message?.trim() ||
    (blocked
      ? `Version ${version} has a problem and must be updated.`
      : `Version ${version} is no longer supported. Please install the latest version.`)
  );
}

