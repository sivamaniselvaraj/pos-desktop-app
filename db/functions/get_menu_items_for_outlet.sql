create or replace function get_menu_items_for_outlet(p_outlet_id uuid)
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  select to_jsonb(mi) || jsonb_build_object('category_id', c.id, 'category_name', c.name)
  from menu_items mi
  left join categories c on c.id = mi.category_id and c.outlet_id = mi.outlet_id
  where mi.outlet_id =  p_outlet_id
  order by c.name, mi.name;
$$;

grant execute on function get_menu_items_for_outlet(uuid) to anon, authenticated;