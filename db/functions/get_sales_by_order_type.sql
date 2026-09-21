-- ============================================================================
-- get_sales_by_order_type() / get_sales_by_type_bucketed(): order-type
-- statistics for the Sales Report page
-- ============================================================================
-- Same conventions as get_sales_report_uid: auth.uid() -> profiles.outlet_id
-- gate, status = 'completed' only (a sales report reflects closed
-- transactions, not open/cancelled ones), created_at in Asia/Kolkata for
-- bucketing/filtering. order_type values ('dine-in' | 'pickup' | 'delivery')
-- are the confirmed FoodOrder.orderType union already used throughout
-- printerManager.ts — safe to reference by literal value here, unlike most
-- column names in this file which have needed hedging.

-- Range total — one row per type, for the whole selected date range. Backs
-- the three summary stat cards.
create or replace function get_sales_by_order_type(p_from date, p_to date)
returns table (order_type text, order_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select o.order_type, count(*)::bigint as order_count
  from orders o
  join profiles p on p.user_id = auth.uid()
  where p.role in ('manager', 'owner', 'admin')
    and p.outlet_id = o.outlet_id
    and o.status = 'completed'
    and (o.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to
  group by o.order_type
  order by o.order_type;
$$;

grant execute on function get_sales_by_order_type(date, date) to authenticated;