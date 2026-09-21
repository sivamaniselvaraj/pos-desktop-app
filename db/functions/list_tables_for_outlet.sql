create or replace function list_tables_for_outlet()
returns table (
  table_id uuid,
  table_number text,
  table_state text,
  order_id uuid,
  order_status text,
  order_created_at timestamptz,
  order_total_amount numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    t.id as table_id,
    t.table_number::text as table_number,
    t.status as table_state,
    o.id as order_id,
    o.status as order_status,
    o.created_at as order_created_at,
    o.total_amount as order_total_amount
  from tables t
  join profiles p on p.user_id = auth.uid()
  -- Most recent order per table, any status — this is what actually
  -- distinguishes "active" (yellow) from "just paid" (green) from "no
  -- recent order" (empty/available). tables.state alone can't do this: it
  -- flips back to 'open' (free) the MOMENT an order settles, so a purely
  -- state-based query couldn't tell "just paid, still worth showing a
  -- reprint option" apart from "been empty for hours."
  left join lateral (
    select ord.*
    from orders ord
    where ord.table_id = t.id
    order by ord.created_at desc
    limit 1
  ) o on true
  where p.role in ('manager', 'owner', 'admin')
    and t.outlet_id = p.outlet_id
  order by t.table_number;
$$;

grant execute on function list_tables_for_outlet() to authenticated;