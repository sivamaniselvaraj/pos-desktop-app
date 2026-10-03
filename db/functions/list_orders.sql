-- ============================================================================
-- ORDERS LIST RPCs
-- ============================================================================
-- All gated on the caller being role in ('manager','owner','admin') AND
-- outlet-matched to the target order/caller's profile.outlet_id — same
-- pattern as the sales report RPCs. Reads (list_orders, get_order_detail)
-- silently return empty for an unauthorized caller; mutations (edit/delete
-- item, cancel/complete order) raise an exception instead, since a silent
-- no-op on a mutation is actively misleading.
--
-- ASSUMPTIONS carried over from get_top_items, still unverified against the
-- live schema: order_items.quantity / unit_price / total_price / menu_item_id
-- column names. If these RPCs error or misbehave, check those first — same
-- class of bug as the profiles.id vs profiles.user_id issue found earlier.
--
-- Tax is deliberately NOT recomputed by edit_order_item/delete_order_item —
-- there's no per-order tax rate stored anywhere to recompute it from
-- proportionally. Only orders.total_amount is kept in sync with item changes.

-- ---------------------------------------------------------------------------
-- list_orders(): paginated, status-filtered, date-range-filtered, and now
-- order-id-searchable list for the caller's outlet. total_rows is repeated
-- on every row (standard window-function pagination pattern) so the client
-- can compute page count without a second query.
--
-- p_search matches ANY substring of the order's UUID text (case-insensitive)
-- — not just a prefix — since the UI only ever shows the first 8 characters
-- of the id, and an operator searching from that displayed fragment is
-- matching a prefix in practice, but substring is more forgiving if they
-- paste a longer id copied from elsewhere (e.g. a receipt or another
-- screen) that doesn't happen to start at position 0.
--
-- Postgres's `create or replace function` cannot change an existing
-- function's ARGUMENT LIST any more than it can change its return shape —
-- adding p_search here makes this a different signature from the deployed
-- 5-arg version, which would otherwise sit alongside it as a second,
-- confusing overload rather than replacing it. Drop the old one first.
--
-- table_id/table_number were added (dine-in rows need to show/resolve the
-- table, not just the order), and invoice_number after that — each changed
-- the return shape, so every previous signature is dropped first too, per
-- this file's established convention.
--
-- GROUPED BY INVOICE (latest change): the grid used to show one row per
-- individual order/round, even though a dine-in table's rounds already all
-- share one invoice_number once assigned. Now the rows are grouped by
-- group_key = coalesce(invoice_number, order_id::text) — an order without an
-- invoice_number (only possible for rows created before this feature
-- shipped) falls back to grouping with itself, so nothing pre-existing
-- silently disappears or merges into a catch-all bucket.
--   - status: 'open' if ANY order in the group is still open, else the
--     status of the group's most-recently-created order.
--   - totals/item_count: summed across the group EXCLUDING cancelled orders
--     (a cancelled round contributed nothing that was ever charged/served).
--   - created_at: the EARLIEST order in the group (when the invoice/table's
--     activity actually started).
--   - order_id/table_id/table_number/invoice_number: taken from the
--     earliest order in the group (the "anchor") — order_id in particular is
--     what row-level actions (print/complete/cancel) still act on, since
--     those remain single-order operations; a grouped (order_count > 1) row
--     disables Complete/Cancel in the UI rather than guessing which round a
--     click should apply to. Print for a dine-in row always reprints the
--     whole current table batch (reprintTableBill), not just the anchor.
--   - order_count: lets the client show "x orders" and decide whether to
--     disable per-round actions.
-- Status filtering (p_status) is applied to this GROUP status, so filtering
-- "Active" surfaces a table with any open round even if an earlier round
-- under the same invoice was already completed.
--
-- PERFORMANCE FIX (this change): the first grouped version ran the
-- item_count/has_edits subqueries — a scan of order_items per order — for
-- EVERY order in the outlet's entire filtered history before applying
-- p_status or pagination, because status is now a GROUP property that has
-- to be known before it can be filtered on. On any real order volume that's
-- an unbounded amount of work per call and it started timing out
-- ("canceling statement due to statement timeout"). Also, orders had no
-- index at all on (outlet_id, created_at) or (outlet_id, invoice_number),
-- so even the base scan was sequential (see db/schema.sql — indexes added
-- alongside this fix).
--
-- Fixed by splitting into two phases:
--   1. group_key/anchor/status computed from `base` alone — no order_items
--      touched — then p_status filtered and the result paginated. This is
--      cheap: just grouping/aggregating the (now indexed) orders rows
--      themselves.
--   2. item_count/has_edits/money totals are computed ONLY for the groups
--      on the current page (`paged`, at most p_page_size groups) via a
--      lateral join into order_items — so the expensive per-order work is
--      now bounded by page size, not by the outlet's total order history.
--
-- That fixed the timeout, but `base` — the grouping pass in phase 1 — still
-- scans/groups every order matching p_from/p_to/p_search, and with ALL
-- THREE left null (every filter cleared) that's still the outlet's entire
-- history, which on enough orders is slow enough to look like a hang even
-- without erroring. `base` now falls back to a 90-day window in exactly
-- that case (see its WHERE clause below) — any explicit date range or
-- search term still overrides it and is honored as given.
--
-- p_outlet_id (this change): the outlet used to be resolved purely from the
-- caller's own profile (select outlet_id from profiles where user_id =
-- auth.uid()) -- deliberate at the time, since Orders List is a login-gated
-- admin page unlike the menu-cache/HTTP-server flows, which resolve outlet
-- from config.outletId because they must keep working with nobody logged
-- in (see config.ts). Now the desktop app passes config.outletId explicitly
-- instead, same as get_menu_items_for_outlet(). The profile lookup stays --
-- it's still what proves the caller has a manager/owner/admin role -- but it
-- now also has to match p_outlet_id, so a caller can only ever list the
-- outlet their own profile belongs to; passing a different outlet's id just
-- yields an empty `caller` CTE (and therefore an empty, not another
-- outlet's, result) rather than actually granting cross-outlet access.
-- ---------------------------------------------------------------------------
drop function if exists list_orders(text, date, date, integer, integer);
drop function if exists list_orders(text, text, date, date, integer, integer);
drop function if exists list_orders(uuid, text, text, date, date, integer, integer);

-- SCALING REWRITE: earlier versions grouped EVERY order matching the filters
-- (window functions / GROUP BY over the whole matching set) just to return
-- one page, so cost grew linearly with history — ~1s at 185k orders, ~9s at
-- 1.5M, past Supabase's statement timeout. Now cost is bounded by the page:
--   * `cand` walks orders newest-first through idx_orders_outlet_created_at
--     and keeps only each invoice's FIRST order (lowest order_number) — the
--     group "anchor" — via an index-backed NOT EXISTS on
--     idx_orders_outlet_invoice_number. Legacy rows with no invoice_number
--     are their own group.
--   * the group's order_count/status is looked up per candidate through the
--     same invoice index (a handful of rows), then p_status filters it.
--   * LIMIT stops the walk once the page (plus lookahead) is filled, so the
--     planner never touches the rest of the history.
--   * date predicates are written as plain created_at range comparisons
--     (sargable); `created_at::date >= p_from` could not use the index.
--   * total_rows is no longer an exact count over all history (that count IS
--     the linear cost). It is counted only up to a 100-row lookahead beyond
--     the current page (total_rows = rows found up to page + a 100-row lookahead).
--     The UI shows "N+" when total_rows reaches page*page_size + 100.
--   * money totals/item_count are still computed only for the page's groups.
-- Semantics note: p_from/p_to/p_search apply to a group's ANCHOR order (its
-- first round); a search also matches any other round of the invoice.
create or replace function list_orders(
  p_outlet_id uuid,
  p_status text default null, -- 'active' | 'completed' | 'cancelled' | null (all)
  p_search text default null, -- substring match against the order id (case-insensitive)
  p_from date default null,
  p_to date default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns table (
  order_id uuid,
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
  invoice_number text,
  order_number text,
  order_count integer,
  cancelled_count integer,
  total_rows bigint
)
language sql
stable
security definer
set search_path = public
-- jit = off is REQUIRED, not a micro-optimisation: with parameters the planner
-- estimates a huge cost for this query (it cannot see that LIMIT stops the
-- walk after ~a page), which trips JIT compilation — measured ~1.1s of pure
-- JIT startup on a call whose real execution is ~15ms.
set jit = off
as $$
  with caller as (
    select p.outlet_id
    from profiles p
    where p.user_id = auth.uid()
      and p.role in ('manager', 'owner', 'admin')
      and p.outlet_id = p_outlet_id
  ),
  cand as (
    select o.id as order_id, o.order_type, o.created_at, o.table_id, o.invoice_number, o.order_number,
           o.outlet_id, g.order_count, g.cancelled_count, g.status
    from caller c
    join orders o on o.outlet_id = c.outlet_id
    cross join lateral (
      select count(*)::integer as order_count,
            (count(*) filter (where m.status = 'cancelled'))::integer as cancelled_count,
             case when bool_or(m.status not in ('cancelled', 'completed')) then 'open'
                  else (array_agg(m.status order by m.order_number desc))[1] end as status
      from orders m
      where m.id = o.id
         or (o.invoice_number is not null
             and m.outlet_id = o.outlet_id
             and m.invoice_number = o.invoice_number)
    ) g
    where
      -- default window when nothing else narrows the walk
      (p_from is not null or p_to is not null
         or (p_search is not null and p_search <> '')
         or o.created_at >= now() - interval '20 days')
      and (p_from is null or o.created_at >= p_from::timestamptz)
      and (p_to is null or o.created_at < (p_to + 1)::timestamptz)
      -- anchor only: no earlier round on the same invoice
      and (o.invoice_number is null
           or not exists (
             select 1 from orders e
             where e.outlet_id = o.outlet_id
               and e.invoice_number = o.invoice_number
               and e.order_number < o.order_number))
      and (p_search is null or p_search = ''
           or o.order_number in (
                select s.order_number from orders s
                where s.outlet_id = p_outlet_id
                  and s.order_number::text ilike '%' || p_search || '%')
           or o.invoice_number in (
                select s.invoice_number from orders s
                where s.outlet_id = p_outlet_id
                  and s.id::text ilike '%' || p_search || '%'))
      and (p_status is null
           or (p_status = 'active' and g.status not in ('cancelled', 'completed'))
           or (p_status = 'completed' and g.status = 'completed')
            or (p_status = 'cancelled' and g.cancelled_count > 0))
    order by o.created_at desc
    limit (greatest(p_page - 1, 0) * greatest(p_page_size, 1)) + greatest(p_page_size, 1) + 100
  ),
  numbered as (
    select c.*, row_number() over (order by c.created_at desc) as rn,
           count(*) over () as fetched
    from cand c
  ),
  paged as (
    select n.*
    from numbered n
    where n.rn > greatest(p_page - 1, 0) * greatest(p_page_size, 1)
      and n.rn <= greatest(p_page, 1) * greatest(p_page_size, 1)
  ),
  totals as (
    select
      p.order_id as anchor_id,
      coalesce(sum(m.total_amount) filter (where m.status <> 'cancelled'), 0) as total_amount,
      coalesce(sum(m.subtotal) filter (where m.status <> 'cancelled'), 0) as subtotal_amount,
      coalesce(sum(m.tax_amount) filter (where m.status <> 'cancelled'), 0) as tax_amount,
      coalesce(sum(m.container_amount) filter (where m.status <> 'cancelled'), 0) as container_charge_amount,
      coalesce(sum(m.discount_amount) filter (where m.status <> 'cancelled'), 0) as discount_amount,
      coalesce(sum(items.qty) filter (where m.status <> 'cancelled'), 0) as item_count
    from paged p
    join orders m
      on m.id = p.order_id
      or (p.invoice_number is not null
          and m.outlet_id = p.outlet_id
          and m.invoice_number = p.invoice_number)
    left join lateral (
      select sum(oi.quantity) filter (where not oi.is_deleted) as qty
      from order_items oi
      where oi.order_id = m.id
    ) items on true
    group by p.order_id
  )
  select
    p.order_id,
    p.order_type,
    p.created_at,
    coalesce(t.item_count, 0)::bigint as item_count,
    coalesce(t.subtotal_amount, 0) as subtotal_amount,
    coalesce(t.tax_amount, 0) as tax_amount,
    coalesce(t.container_charge_amount, 0) as container_charge_amount,
    coalesce(t.discount_amount, 0) as discount_amount,
    coalesce(t.total_amount, 0) as total_amount,
    p.status,
    p.table_id,
    tb.table_number,
    p.invoice_number,
    p.order_number,
    p.order_count,
    p.cancelled_count,
    p.fetched::bigint as total_rows
  from paged p
  left join totals t on t.anchor_id = p.order_id
  left join tables tb on tb.id = p.table_id
  order by p.created_at desc;
$$;

grant execute on function list_orders(uuid, text, text, date, date, integer, integer) to authenticated;