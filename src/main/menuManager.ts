import { db, type MenuItemValues } from './data';
import { refreshMenuCache } from './menuCache';
import { config } from './config';
import type { MenuCacheSnapshot, MenuCategory, MenuCategoryAdmin, SaveMenuItemPayload } from '../shared/types';

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
  return db.menu.listCategories(config.outletId);
}

export function listMenuCategoriesAdmin(): Promise<MenuCategoryAdmin[]> {
  return db.menu.listCategoriesAdmin();
}

/** Add (no id) or rename a category. The database checks menu.categories and that the name is unique in the outlet. */
export async function saveMenuCategory(p: { id?: string; name: string }): Promise<void> {
  const name = p?.name?.trim();
  if (!name) throw new Error('Category name is required.');
  if (name.length > 60) throw new Error('The category name must be 60 characters or fewer.');
  await db.menu.saveCategory(p.id || null, name);
  await refreshMenuCache(); // the menu served to phones carries category names
}

/** Saves the display order (every category id, in the wanted order) and refreshes the menu served to phones. */
export async function reorderMenuCategories(ids: string[]): Promise<void> {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((i) => typeof i !== 'string' || !i)) {
    throw new Error('Nothing to reorder.');
  }
  await db.menu.reorderCategories(ids);
  await refreshMenuCache();
}

/** Deactivating turns the category's items off (reason "Category deactivated"). Activating leaves them off. */
export async function setMenuCategoryActive(id: string, isActive: boolean): Promise<{ itemsTurnedOff: number }> {
  if (!id) throw new Error('Choose a category.');
  const itemsTurnedOff = await db.menu.setCategoryRecordActive(id, isActive);
  await refreshMenuCache();
  return { itemsTurnedOff };
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
  const taxName = typeof p.taxName === 'string' ? p.taxName.trim() : '';
  if (!taxName || taxName.length > 30) throw new Error('Choose a tax for this item.');
  if (typeof p.taxPercent !== 'number' || !Number.isFinite(p.taxPercent) || p.taxPercent < 0 || p.taxPercent > 100) {
    throw new Error('Choose a tax for this item.');
  }
  if (typeof p.priceIncludesTax !== 'boolean') throw new Error('Choose whether the price includes tax.');
  if (typeof p.incentiveApplicable !== 'boolean') throw new Error('Choose whether an incentive applies.');
  let incentiveType: 'percent' | 'fixed' | null = null;
  let incentiveValue: number | null = null;
  if (p.incentiveApplicable) {
    if (p.incentiveType !== 'percent' && p.incentiveType !== 'fixed') throw new Error('Choose percentage or fixed amount for the incentive.');
    const v = p.incentiveValue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (p.incentiveType === 'percent' && v > 100)) {
      throw new Error(p.incentiveType === 'percent' ? 'The incentive percentage must be between 0 and 100.' : 'The incentive amount must be 0 or more.');
    }
    incentiveType = p.incentiveType;
    incentiveValue = Math.round(v * 100) / 100;
  }
  // An item saved as off needs a reason. Only sent on when the save turns it off (or creates it off);
  // an item that is already off keeps its reason.
  const inactiveReason = !p.isActive && p.inactiveReason ? p.inactiveReason.trim().slice(0, 200) : undefined;
  if (!p.isActive && p.inactiveReason !== undefined && p.inactiveReason !== null && !inactiveReason) {
    throw new Error('Give a reason for turning this item off.');
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
    taxName,
    taxPercent: Math.round(p.taxPercent * 100) / 100,
    priceIncludesTax: p.priceIncludesTax,
    incentiveApplicable: p.incentiveApplicable,
    incentiveType,
    incentiveValue,
    inactiveReason,
  };

  if (p.id) {
    await db.menu.updateItem(config.outletId, p.id, values);
  } else {
    await db.menu.insertItem(config.outletId, values);
  }

  // Refresh now so the New Order page and Android see the change immediately.
  return refreshMenuCache();
}
