-- ============================================================================
-- RPC: get_top_items(p_from, p_to, p_limit)
-- ============================================================================
-- Top-selling items (by quantity sold) in the caller's outlet for the given
-- date range, from settled orders only. Same auth.uid() resolution and role
-- gate as get_sales_report.

create or replace function get_top_items(p_from date, p_to date, p_limit integer default 10)
returns table (
  menu_item_id uuid,
  name text,
  quantity_sold bigint,
  revenue numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    mi.id as menu_item_id,
    mi.name,
    sum(oi.quantity)::bigint as quantity_sold,
    sum(oi.total_price) as revenue
  from order_items oi
  join orders o on o.id = oi.order_id
  join menu_items mi on mi.id = oi.menu_item_id
  join profiles p on p.user_id = auth.uid()
  where p.role in ('manager', 'owner', 'admin')
    and p.outlet_id is not null
    and o.outlet_id = p.outlet_id
    and o.status = 'completed'
    and (o.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to
  group by mi.id, mi.name
  order by quantity_sold desc
  limit p_limit;
$$;

grant execute on function get_top_items(date, date, integer) to anon, authenticated;

-- Supports both report RPCs.
create index if not exists idx_orders_outlet_completed
  on orders (outlet_id, status, created_at);
