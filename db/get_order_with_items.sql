-- ============================================================================
-- RPC: get_order_with_items(p_order_id)
-- ============================================================================
-- Returns a single order (by its business order_id) with its line items nested
-- under an "items" array, as one JSON object. Call it from the client with:
--
--   const { data, error } = await supabase.rpc('get_order_with_items', {
--     p_order_id: 'ORD-2024-001',
--   });
--   // data is the order object (or null if not found); data.items is the array
--
-- Assumes line items live in `order_items` with a column `order_id` that holds
-- the same business key as orders.order_id. Adjust the join column if yours
-- differs.
--
-- SECURITY DEFINER: the function runs with the owner's privileges, so the local
-- print path (which uses the anon key and has no logged-in user) can look up an
-- order by exact id even when RLS is enabled on `orders` / `order_items`,
-- WITHOUT granting broad table-level SELECT to anon. The only thing exposed is
-- "look up one order if you already know its exact order_id". If you'd rather it
-- respect RLS instead, change `security definer` to `security invoker`.

create or replace function get_order_with_items(p_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select to_jsonb(o) || jsonb_build_object('table_number', tbls.table_number)
         || jsonb_build_object(
              'items',
              coalesce(
                (
                  select jsonb_agg((select to_jsonb(item_cols) from
                  (select oi.id, oi.status, oi.quantity, oi.unit_price, oi.total_price, mi.name) item_cols))
                  from order_items oi, menu_items mi
                  where 
                  mi.id = oi.menu_item_id
                  and oi.order_id = o.id
                ),
                '[]'::jsonb
              )
            )
  from orders o, tables tbls
  where 
  tbls.id = o.table_id and
  o.id = p_order_id;
$$;

-- Allow the API roles to execute it (anon for the print path, authenticated for
-- the operator UI). Adjust if you removed anon access.
grant execute on function get_order_with_items(uuid) to anon, authenticated;

-- Helps the lookup/join stay fast as data grows.
create index if not exists idx_order_items_order_id on order_items (order_id);