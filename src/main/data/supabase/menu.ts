import { getAnonClient, getAuthedClient } from './sessionClient';
import type { MenuItemValues, MenuRepository } from '../ports';

function toRow(v: MenuItemValues) {
  return {
    name: v.name,
    category_id: v.categoryId,
    price: v.price,
    description: v.description,
    is_veg: v.isVeg,
    container_charge: v.containerCharge,
    cost_price: v.costPrice,
    search_key: v.searchKey,
    cooking_time: v.cookingTime,
    sort_order: v.sortOrder,
    image_url: v.imageUrl,
    is_available: v.isAvailable,
    is_active: v.isActive,
  };
}

export const menu: MenuRepository = {
  // Two plain reads merged here (no dependence on a foreign-key name for an
  // embedded join): the item's columns plus category_id / category_name.
  // Anon client: has to work all day whether or not anyone is signed in.
  async fetchMenu(outletId) {
    const supabase = getAnonClient();
    if (!supabase) throw new Error('Database client unavailable.');
    const [menuRes, catRes] = await Promise.all([
      supabase.from('menu_items').select('*').eq('outlet_id', outletId).order('name'),
      supabase.from('categories').select('id, name'),
    ]);
    if (menuRes.error) throw new Error(menuRes.error.message);
    if (catRes.error) throw new Error(catRes.error.message);
    const categoryName = new Map(
      ((catRes.data ?? []) as { id: string; name: string }[]).map((c) => [String(c.id), c.name]),
    );
    return ((menuRes.data ?? []) as Record<string, unknown>[]).map((row) => {
      const cid = row.category_id ? String(row.category_id) : null;
      return { ...row, category_id: cid, category_name: cid ? (categoryName.get(cid) ?? null) : null };
    });
  },

  // RLS ("managers manage own outlet menu") is the permission check: a caller
  // without menu.edit, or an item of another outlet, updates zero rows.
  async setItemActive(menuItemId, isActive) {
    const { data, error } = await getAuthedClient()
      .from('menu_items')
      .update({ is_active: isActive })
      .eq('id', menuItemId)
      .select('id');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) throw new Error('Not authorized, or menu item not found');
  },

  // RLS ("members read own org categories") limits this to the caller's organization.
  async listCategories() {
    const { data, error } = await getAuthedClient().from('categories').select('id, name').order('name');
    if (error) throw new Error(error.message);
    return ((data ?? []) as { id: string; name: string }[]).map((c) => ({ id: String(c.id), name: String(c.name) }));
  },

  async findItemIdsByName(outletId, name) {
    const { data, error } = await getAuthedClient()
      .from('menu_items')
      .select('id')
      .eq('outlet_id', outletId)
      .ilike('name', name.replace(/[%_\\]/g, '\\$&'));
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => String(r.id));
  },

  async insertItem(outletId, values) {
    const { error } = await getAuthedClient().from('menu_items').insert({ ...toRow(values), outlet_id: outletId });
    if (error) throw new Error(error.message);
  },

  async updateItem(outletId, id, values) {
    const { data, error } = await getAuthedClient()
      .from('menu_items')
      .update({ ...toRow(values), updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('outlet_id', outletId)
      .select('id');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) throw new Error('Not allowed, or the item no longer exists.');
  },
};
