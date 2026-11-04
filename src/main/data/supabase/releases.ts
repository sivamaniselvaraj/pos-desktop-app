import { getAuthedClient } from './sessionClient';
import type { ReleaseRepository } from '../ports';

/** The one release-policy row, read through a security-definer function (any signed-in user). */
export const releases: ReleaseRepository = {
  async getPolicy() {
    const { data, error } = await getAuthedClient().rpc('get_app_release_policy');
    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
    if (!row) return null;
    return {
      minimumVersion: row.minimum_version ? String(row.minimum_version) : null,
      blockedVersions: Array.isArray(row.blocked_versions) ? row.blocked_versions.map(String) : [],
      message: row.message ? String(row.message) : null,
    };
  },
};
