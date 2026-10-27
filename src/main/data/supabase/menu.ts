import { randomUUID } from 'crypto';
import { getAuthedClient } from './sessionClient';
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
    tax_name: v.taxName,
    tax_rate_percent: v.taxPercent,
    price_includes_tax: v.priceIncludesTax,
    incentive_applicable: v.incentiveApplicable,
    incentive_type: v.incentiveApplicable ? v.incentiveType : null,
    incentive_value: v.incentiveApplicable ? v.incentiveValue : null,
    ...(v.inactiveReason ? { inactive_reason: v.inactiveReason } : {}),
  };
}

/**
 * The columns the menu list needs (Menu Items page, New order, the phone API). The wide
 * ones (description, image_url, cost_price, cooking_time, the item's sort_order) are left
 * out; the Edit form reads the full row with fetchItem.
 */
const MENU_LIST_COLUMNS = 'id, name, category_id, price, is_veg, is_active, is_available, container_charge,  search_key, tax_name, tax_rate_percent, price_includes_tax, incentive_applicable, incentive_type, incentive_value, inactive_reason, inactive_since, inactive_by_name';

export const menu: MenuRepository = {
  // Two plain reads merged here (no dependence on a foreign-key name for an
  // embedded join): the item's columns plus category_id / category_name.
  // Anon client: has to work all day whether or not anyone is signed in.
  async fetchMenu(outletId) {
    const supabase = getAuthedClient();
    if (!supabase) throw new Error('Database client unavailable.');
    const [menuRes, catRes] = await Promise.all([
      supabase.from('menu_items').select(MENU_LIST_COLUMNS).eq('outlet_id', outletId).order('name'),
      supabase.from('categories').select('id, name, sort_order'),
    ]);
    if (menuRes.error) throw new Error(menuRes.error.message);
    if (catRes.error) throw new Error(catRes.error.message);
    const cats = (catRes.data ?? []) as { id: string; name: string; sort_order: number | null }[];
    const categoryName = new Map(cats.map((c) => [String(c.id), c.name]));
    const categorySort = new Map(cats.map((c) => [String(c.id), c.sort_order == null ? null : Number(c.sort_order)]));
    return ((menuRes.data ?? []) as Record<string, unknown>[]).map((row) => {
      const cid = row.category_id ? String(row.category_id) : null;
      return {
        ...row,
        category_id: cid,
        category_name: cid ? (categoryName.get(cid) ?? null) : null,
        // The category's display order, so every screen and the phone app can list categories the same way.
        category_sort_order: cid ? (categorySort.get(cid) ?? null) : null,
      };
    });
  },

  // The whole row of one item, for the Edit form. RLS limits it to the caller's outlet.
  async fetchItem(outletId, menuItemId) {
    const { data, error } = await getAuthedClient().from('menu_items').select('*').eq('outlet_id', outletId).eq('id', menuItemId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Menu item not found.');
    return data as Record<string, unknown>;
  },

  // RLS ("managers manage own outlet menu") is the permission check: a caller
  // without menu.edit, or an item of another outlet, updates zero rows.
  async setItemActive(menuItemId, isActive, reason) {
    const { data, error } = await getAuthedClient()
      .from('menu_items')
      .update(isActive ? { is_active: true } : { is_active: false, inactive_reason: reason ?? null })
      .eq('id', menuItemId)
      .select('id');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) throw new Error('Not authorized, or menu item not found');
  },

  // One update for the whole selection. Same RLS check as setItemActive; only this
  // outlet's items are touched, and only those not already in the wanted state.
  // The shared change_batch lets the availability log tell this selection apart.
  async setItemsActive(outletId, menuItemIds, isActive, reason) {
    const { data, error } = await getAuthedClient()
      .from('menu_items')
      .update({
        ...(isActive ? { is_active: true } : { is_active: false, inactive_reason: reason ?? null }),
        change_scope: 'item',
        change_batch: randomUUID(),
      })
      .eq('outlet_id', outletId)
      .eq('is_active', !isActive)
      .in('id', menuItemIds)
      .select('id');
    if (error) throw new Error(error.message);
    return data?.length ?? 0;
  },

  // Same RLS check as setItemActive; only this outlet's items are touched.
  async setCategoryActive(outletId, categoryId, isActive, reason) {
    // Turning off only touches items that are on, so an item already off keeps its own reason.
    let q = getAuthedClient()
      .from('menu_items')
      // change_scope / change_batch tell the availability log this was one category switch.
      .update({
        ...(isActive ? { is_active: true } : { is_active: false, inactive_reason: reason ?? null }),
        change_scope: 'category',
        change_batch: randomUUID(),
      })
      .eq('outlet_id', outletId)
      .eq('is_active', !isActive);
    q = categoryId ? q.eq('category_id', categoryId) : q.is('category_id', null);
    const { data, error } = await q.select('id');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) throw new Error('Not authorized, or no items in this category');
    return data.length;
  },

  // RLS ("members read own org categories") limits this to the caller's organization.
  async listCategories(outletId) {
    const { data, error } = await getAuthedClient().from('categories').select('id, name').eq('is_active', true)
      .eq('outlet_id', outletId)
      .order('sort_order', { ascending: true, nullsFirst: false })
      .order('name');
    if (error) throw new Error(error.message);
    return ((data ?? []) as { id: string; name: string }[]).map((c) => ({ id: String(c.id), name: String(c.name) }));
  },

  async listCategoriesAdmin() {
    const { data, error } = await getAuthedClient().rpc('get_menu_categories_admin');
    if (error) throw new Error(error.message);
    return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ''),
      sortOrder: Number(r.sort_order),
      isActive: r.is_active !== false,
      itemCount: Number(r.item_count ?? 0),
      activeItemCount: Number(r.active_item_count ?? 0),
    }));
  },

  async saveCategory(id, name) {
    const { error } = await getAuthedClient().rpc('save_menu_category', { p_id: id, p_name: name });
    if (error) throw new Error(error.message);
  },

  async reorderCategories(ids) {
    const { error } = await getAuthedClient().rpc('reorder_menu_categories', { p_ids: ids });
    if (error) throw new Error(error.message);
  },

  async setCategoryRecordActive(id, isActive) {
    const { data, error } = await getAuthedClient().rpc('set_menu_category_active', { p_id: id, p_active: isActive });
    if (error) throw new Error(error.message);
    return Number((data as Record<string, unknown> | null)?.items_turned_off ?? 0);
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
