-- ============================================================================
-- RPC: get_sales_report(p_from, p_to, p_bucket)
-- ============================================================================
-- Settled orders in the caller's outlet for the given date range, aggregated
-- by day or month (p_bucket = 'day' | 'month', default 'day'). Results are
-- grouped by bucket only — one row per day/month, never per order. Bucketing
-- uses Asia/Kolkata local time so a late-night order lands in the correct
-- business day rather than shifting across the UTC boundary.
--
-- p_bucket only feeds a CASE expression below (never concatenated into SQL),
-- so there's no injection surface from it; any value other than 'month' is
-- treated as 'day'.
--
-- Outlet and role are resolved from auth.uid() via profiles, not from a
-- client parameter — this is the actual access boundary, the UI's
-- manager/owner/admin nav gating is convenience on top of this. Callers whose
-- profile isn't manager/owner/admin, or who have no outlet_id, get an
-- empty result rather than an error (keeps the client simple).

create or replace function get_sales_report_uid(p_from date, p_to date, p_bucket text default 'day')
returns table (
  bucket_date date,
  order_count bigint,
  tax_total numeric,
  net_total numeric,
  avg_order_value numeric
)
language sql
stable
security definer
set search_path = public
as $$

select date_trunc(
      case when p_bucket = 'month' then 'month' else 'day' end,
      (o.created_at at time zone 'Asia/Kolkata')
    )::date as bucket_date, count(*)::bigint as order_count,
    sum(o.tax_amount) as tax_total,
    sum(o.total_amount) as net_total,
    round((sum(o.total_amount) / count(*)) ::numeric, 2)as avg_order_value
  from orders o
  join profiles p on p.user_id = auth.uid()
   where p.role in ('manager', 'owner', 'admin')
    and p.outlet_id is not null
     and o.outlet_id = p.outlet_id
    and o.status = 'completed'
    and (o.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to
  group by 1
  order by 1;

$$;

grant execute on function get_sales_report_uid(date, date, text) to anon, authenticated;