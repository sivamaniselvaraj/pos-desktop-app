create or replace function get_pending_kot_items(p_order_id uuid)
returns table (
  id uuid,
  menu_item_id uuid,
  name text,
  quantity integer,
  unit_price numeric,
  total_price numeric,
  status text,
  special_instructions text,
  kot_printed boolean,
  kot_printed_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    oi.id,
    oi.menu_item_id,
    mi.name,
    oi.quantity,
    oi.unit_price,
    oi.total_price,
    oi.status,
    oi.special_instructions,
    oi.kot_printed,
    oi.kot_printed_at
  from order_items oi
  join menu_items mi on mi.id = oi.menu_item_id
  where oi.order_id = p_order_id
    and oi.kot_printed = false
  order by oi.created_at nulls last, oi.id;
$$;

grant execute on function get_pending_kot_items(uuid) to anon, authenticated;

create index if not exists idx_order_items_pending
  on order_items (order_id) where kot_printed = false;