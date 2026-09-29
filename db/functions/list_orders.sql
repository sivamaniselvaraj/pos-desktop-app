drop function if exists list_orders(text, date, date, integer, integer);
drop function if exists list_orders(text, text, date, date, integer, integer);

create or replace function list_orders(
  p_status text default null, -- 'active' | 'completed' | 'cancelled' | null (all)
  p_search text default null, -- substring match against the order id (case-insensitive)
  p_from date default null,
  p_to date default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns table (
  order_id uuid,
  order_number text,
  invoice_number text,
  order_type text,
  created_at timestamptz,
  item_count bigint,
  subtotal_amount numeric,
  tax_amount numeric,
  container_charge_amount numeric,
  discount_amount numeric,
  total_amount numeric,
  status text,
  table_id uuid,
  table_number text,
  has_edits boolean,
  total_rows bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with caller as (
    select p.outlet_id
    from profiles p
    where p.user_id = auth.uid() and p.role in ('manager', 'owner', 'admin')
  ),
  base as (
    select o.id as order_id, o.order_number, o.order_type, o.created_at, o.subtotal as subtotal_amount,
           o.tax_amount, o.container_amount as container_charge_amount, o.discount_amount,
           o.invoice_number, o.table_id
           o.total_amount, o.status
    from orders o, caller c
    where o.outlet_id = c.outlet_id
      and (
        p_status is null
        or (p_status = 'active' and o.status = 'preparing')
        or (p_status = 'completed' and o.status = 'completed')
        or (p_status = 'cancelled' and o.status = 'cancelled')
      )
      and (p_search is null or p_search = '' or o.order_number::text ilike '%' || p_search || '%')
      and (p_from is null or o.created_at::date >= p_from)
      and (p_to is null or o.created_at::date <= p_to)
  )
  select
    b.order_id,
    b.order_number,
    b.invoice_number,
    b.order_type,
    b.created_at,
    coalesce(
      (select sum(oi.quantity) from order_items oi
        where oi.order_id = b.order_id and not oi.is_deleted),
      0
    ) as item_count,
    b.subtotal_amount,
    b.tax_amount,
    b.container_charge_amount,
    b.discount_amount,
    b.total_amount,
    b.status,
    b.table_id,
  tb.table_number,
    exists(
      select 1 from order_items oi
      where oi.order_id = b.order_id and (oi.is_deleted or oi.edited_at is not null)
    ) as has_edits,
    count(*) over () as total_rows
  from base b
  left join tables tb on tb.id = b.table_id
  order by b.created_at desc
  limit greatest(p_page_size, 1)
  offset greatest(p_page - 1, 0) * greatest(p_page_size, 1);
$$;

grant execute on function list_orders(text, text, date, date, integer, integer) to authenticated;