create or replace function mark_order_kot_printed(p_order_id uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  with updated as (
    update order_items
       set kot_printed = true,
           kot_printed_at = now()
     where order_id = p_order_id
       and kot_printed = false
    returning 1
  )
  select count(*)::integer from updated;
$$;

grant execute on function mark_order_kot_printed(uuid) to anon, authenticated;