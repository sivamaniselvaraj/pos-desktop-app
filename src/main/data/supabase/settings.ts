// import { embeddedConfig } from '../../embeddedConfig';

/**
 * Connection settings of the Supabase provider. Getters, not values: they must
 * re-read process.env on every access, because .env.local is loaded after this
 * module is first imported (see the long note at the top of config.ts).
 */
export const supabaseSettings = {
  get url(): string {
    //return process.env.SUPABASE_URL || embeddedConfig.SUPABASE_URL || '';
    return process.env.SUPABASE_URL || '';
  },
  get anonKey(): string {
    //return process.env.SUPABASE_ANON_KEY || embeddedConfig.SUPABASE_ANON_KEY || '';
    return process.env.SUPABASE_ANON_KEY || '';
  },
  get table(): string {
    //return process.env.SUPABASE_TABLE || embeddedConfig.SUPABASE_TABLE || 'orders';
    return process.env.SUPABASE_TABLE || 'orders';
  },
  // DANGER: bypasses Row Level Security entirely. Used only by the legacy
  // fallback in users.ts. Deliberately NEVER read from embeddedConfig:
  // scripts/embed-config.js refuses to build when it is present in .env.build.
  get serviceRoleKey(): string {
    return process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  },
};
