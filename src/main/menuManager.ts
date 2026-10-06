import { db, type MenuItemValues } from './data';
import { refreshMenuCache } from './menuCache';
import { config } from './config';
import type { MenuCacheSnapshot, MenuCategory, SaveMenuItemPayload } from '../shared/types';

/**
 * menuAdmin.ts
 * ---------------------------------------------------------------------------
 * Add / edit menu items from the desktop app. Validation lives here; storage is
 * behind db.menu, which enforces who may write (manager/owner/admin of the
 * outlet), so a staff session simply gets a permission error.
 * The outlet is always this machine's configured outlet, never the payload.
 * ---------------------------------------------------------------------------
 */

export function listMenuCategories(): Promise<MenuCategory[]> {
  return db.menu.listCategories();
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

  // Case-insensitive duplicate check within the outlet.
  const same = await db.menu.findItemIdsByName(config.outletId, name);
  if (same.some((id) => id !== p.id)) {
    throw new Error(`A menu item named "${name}" already exists.`);
  }

  const values: MenuItemValues = {
    name,
    categoryId: p.categoryId,
    price: p.price,
    description: p.description?.trim() || null,
    isVeg: p.isVeg,
    containerCharge,
    costPrice,
    searchKey: p.searchKey?.trim() || null,
    cookingTime: cookingTime ?? 0,
    sortOrder: sortOrder ?? 0,
    imageUrl,
    isAvailable: p.isAvailable,
    isActive: p.isActive,
  };

  if (p.id) {
    await db.menu.updateItem(config.outletId, p.id, values);
  } else {
    await db.menu.insertItem(config.outletId, values);
  }

  // Refresh now so the New Order page and Android see the change immediately.
  return refreshMenuCache();
}
