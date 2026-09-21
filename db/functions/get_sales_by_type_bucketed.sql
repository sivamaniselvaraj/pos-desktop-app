-- Per-bucket breakdown — one row per day/month with a count per type,
-- pivoted server-side (via FILTER) into fixed columns so the client can
-- plot it directly as a grouped bar chart with no client-side reshaping.
create or replace function get_sales_by_type_bucketed(
  p_from date,
  p_to date,
  p_bucket text default 'day'
)
returns table (
  bucket_date date,
  dine_in_count bigint,
  pickup_count bigint,
  delivery_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    date_trunc(
      case when p_bucket = 'month' then 'month' else 'day' end,
      (o.created_at at time zone 'Asia/Kolkata')
    )::date as bucket_date,
    count(*) filter (where o.order_type = 'dine_in')::bigint as dine_in_count,
    count(*) filter (where o.order_type = 'takeaway')::bigint as pickup_count,
    count(*) filter (where o.order_type = 'delivery')::bigint as delivery_count
  from orders o
  join profiles p on p.user_id = auth.uid()
  where p.role in ('manager', 'owner', 'admin')
    and p.outlet_id = o.outlet_id
    and o.status = 'completed'
    and (o.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to
  group by 1
  order by 1;
$$;

grant execute on function get_sales_by_type_bucketed(date, date, text) to authenticated;