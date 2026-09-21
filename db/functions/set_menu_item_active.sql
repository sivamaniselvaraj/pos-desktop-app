-- ============================================================================
-- set_menu_item_active(): toggle a menu item on/off (out of stock, etc.)
-- ============================================================================
-- Same admin-gate pattern as every other mutation in this file. Raises
-- rather than silently no-op'ing — this is a write, and a silent failure
-- here would be actively dangerous (staff believing an out-of-stock item
-- was taken off the menu when the toggle actually failed).
create or replace function set_menu_item_active(p_menu_item_id uuid, p_is_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from menu_items mi
    join profiles p on p.user_id = auth.uid()
    where mi.id = p_menu_item_id
      and p.role in ('manager', 'owner', 'admin')
      and p.outlet_id = mi.outlet_id
  ) then
    raise exception 'Not authorized, or menu item not found';
  end if;

  update menu_items set is_active = p_is_active where id = p_menu_item_id;
end;
$$;

grant execute on function set_menu_item_active(uuid, boolean) to authenticated;