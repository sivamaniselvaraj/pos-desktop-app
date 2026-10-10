/**
 * data/supabase: the Supabase implementation of DataProvider. The ONLY place
 * in the app that imports @supabase/supabase-js or knows a table/column name.
 */
import { supabaseSettings } from './settings';
import type { DataProvider } from '../ports';
import { auth } from './auth';
import { access } from './access';
import { orders } from './orders';
import { orderAdmin } from './orderAdmin';
import { orderEntry } from './orderEntry';
import { tax } from './tax';
import { kots } from './kots';
import { tables } from './tables';
import { menu } from './menu';
import { users } from './users';
import { groups } from './groups';
import { invoices } from './invoices';
import { reports } from './reports';

export function createSupabaseProvider(): DataProvider {
  return {
    name: 'supabase',
    isConfigured: () => Boolean(supabaseSettings.url && supabaseSettings.anonKey),
    auth,
    access,
    orders,
    orderAdmin,
    orderEntry,
    tax,
    kots,
    tables,
    menu,
    users,
    groups,
    invoices,
    reports,
  };
}
