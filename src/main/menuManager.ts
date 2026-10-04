import { getAuthedClient } from './supabaseAuthClient';
import { refreshMenuCache } from './menuCache';
import { config } from './config';
import type { MenuCacheSnapshot, MenuCategory, SaveMenuItemPayload } from '../shared/types';

/**
 * menuAdmin.ts
 * ---------------------------------------------------------------------------
 * Add / edit menu items from the desktop app. Plain table queries; the
 * authorization is RLS on menu_items (manager/owner/admin of the outlet),
 * so a staff session simply gets a permission error from the database.
 * The outlet is always this machine's configured outlet, never the payload.
 * ---------------------------------------------------------------------------
 */

export async function listMenuCategories(): Promise<MenuCategory[]> {
  const supabase = getAuthedClient();
  const { data, error } = await supabase.from('categories').select('id, name').order('name');
  if (error) throw new Error(error.message);
  return ((data ?? []) as { id: string; name: string }[]).map((c) => ({
    id: String(c.id),
    name: String(c.name),
  }));
}

function optNumber(v: number | null | undefined, label: string, min: number, max: number): number | null {
  if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) return null;
  if (typeof v !== 'number' || v < min || v > max) throw new Error(`${label} must be between ${min} and ${max}.`);
  return v;
}

export async function saveMenuItem(p: SaveMenuItemPayload): Promise<MenuCacheSnapshot> {
  if (!config.outletId) throw new Error('OUTLET_ID is not configured for this machine.');
  const name = p.name?.trim();
  if (!name) throw new Error('Name is required.');
  if (!p.categoryId) throw new Error('Choose a category.');
  if (typeof p.price !== 'number' || !(p.price >= 0) || p.price > 1_000_000) {
    throw new Error('Price must be 0 or more.');
  }
  const containerCharge = optNumber(p.containerCharge, 'Container charge %', 0, 100);
  const costPrice = optNumber(p.costPrice, 'Cost price', 0, 1_000_000);
  const cookingTime = optNumber(p.cookingTime, 'Cooking time', 0, 1000);
  const sortOrder = optNumber(p.sortOrder, 'Sort order', -100000, 100000);
  for (const [label, n] of [['Cooking time', cookingTime], ['Sort order', sortOrder]] as const) {
    if (n !== null && !Number.isInteger(n)) throw new Error(`${label} must be a whole number.`);
  }
  const imageUrl = p.imageUrl?.trim() || null;
  if (imageUrl && !/^https?:\/\//i.test(imageUrl)) throw new Error('Image URL must start with http:// or https://');

  const supabase = getAuthedClient();

  // Case-insensitive duplicate check within the outlet.
  const { data: same, error: dupErr } = await supabase
    .from('menu_items')
    .select('id')
    .eq('outlet_id', config.outletId)
    .ilike('name', name.replace(/[%_\\]/g, '\\$&'));
  if (dupErr) throw new Error(dupErr.message);
  if ((same ?? []).some((r) => String(r.id) !== p.id)) {
    throw new Error(`A menu item named "${name}" already exists.`);
  }

  const row = {
    name,
    category_id: p.categoryId,
    price: p.price,
    description: p.description?.trim() || null,
    is_veg: p.isVeg,
    container_charge: containerCharge,
    cost_price: costPrice,
    search_key: p.searchKey?.trim() || null,
    cooking_time: cookingTime ?? 0,
    sort_order: sortOrder ?? 0,
    image_url: imageUrl,
    is_available: p.isAvailable,
    is_active: p.isActive,
  };

  if (p.id) {
    const { data, error } = await supabase
      .from('menu_items')
      .update({ ...row, updated_at: new Date().toISOString() })
      .eq('id', p.id)
      .eq('outlet_id', config.outletId)
      .select('id');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) throw new Error('Not allowed, or the item no longer exists.');
  } else {
    const { error } = await supabase.from('menu_items').insert({ ...row, outlet_id: config.outletId });
    if (error) throw new Error(error.message);
  }

  // Refresh now so the New Order page and Android see the change immediately.
  return refreshMenuCache();
}
