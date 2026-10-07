import { getAuthedClient } from './sessionClient';
import type { AccessRepository } from '../ports';
import type { AccessMenu, MyAccess, OrgSettings } from '../../../shared/types';

export const access: AccessRepository = {
  async fetchMyAccess(): Promise<MyAccess | null> {
    const { data, error } = await getAuthedClient().rpc('get_my_access');
    if (error || !data || typeof data !== 'object') return null;
    const d = data as {
      role: string | null;
      permissions?: string[];
      menus?: AccessMenu[];
      groups?: string[];
      org?: {
        id: string;
        name: string;
        currency_code: string;
        locale: string;
        timezone: string;
        tax_label: string;
      } | null;
    };
    const org: OrgSettings | null = d.org
      ? {
          id: String(d.org.id),
          name: String(d.org.name),
          currencyCode: d.org.currency_code,
          locale: d.org.locale,
          timezone: d.org.timezone,
          taxLabel: d.org.tax_label,
        }
      : null;
    if (d.role) {
      return { role: d.role, org, permissions: d.permissions ?? [], menus: d.menus ?? [], groups: d.groups ?? [] };
    }
    return { role: null, org: null, permissions: [], menus: [] };
  },
};
