-- ---------------------------------------------------------------------------
-- get_orders_by_invoice(): every order sharing one invoice_number, for the
-- Orders List's invoice-grouped detail modal (list_orders() above now
-- returns one row per invoice rather than one row per order/round, so the
-- detail view needs its own way to fetch the whole group back). Outlet-
-- scoped like list_orders(); returns empty rather than raising for an
-- unauthorized caller or an invoice_number that doesn't belong to the
-- caller's outlet, since this is a read.
-- ---------------------------------------------------------------------------
create or replace function get_orders_by_invoice(p_invoice_number text)
returns table (
  order_id uuid,
  order_number text,
  status text
)
language sql
stable
security definer
set search_path = public
as $$
  select o.id as order_id, o.order_number, o.status
  from orders o
  join profiles p
    on p.user_id = auth.uid()
   and p.role in ('manager', 'owner', 'admin')
   and p.outlet_id = o.outlet_id
  where o.invoice_number = p_invoice_number
  order by o.order_number asc;
$$;

grant execute on function get_orders_by_invoice(text) to authenticated;