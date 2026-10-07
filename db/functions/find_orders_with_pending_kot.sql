-- ============================================================================
-- RPC: find_orders_with_pending_kot()
-- ============================================================================
-- Open orders of the CALLER's outlet that still have at least one live line
-- item not yet sent to the kitchen. Used by the KOT reconciliation sweep to
-- find orders whose ticket never printed. One round trip instead of two
-- queries and an id list. Same rule the row-level security applied:
-- orders.view permission, caller's own outlet only. No session, no rows.
--
-- Consumed by findOrdersWithPendingKot() in src/main/data/supabase/orders.ts:
--   supabase.rpc('find_orders_with_pending_kot')
create or replace function find_orders_with_pending_kot()
returns table (order_id uuid, order_type text)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, o.order_type
  from orders o
  join profiles p on p.user_id = auth.uid()
                 and coalesce(p.is_active, true)
                 and p.outlet_id = o.outlet_id
  where has_permission('orders.view')
    and o.status = 'open'
    and exists (select 1 from order_items oi
                 where oi.order_id = o.id
                   and not oi.is_deleted
                   and not oi.kot_printed);
$$;

grant execute on function find_orders_with_pending_kot() to authenticated;

-- Supports the pending-items lookup.
create index if not exists idx_order_items_pending
  on order_items (order_id) where kot_printed = false;