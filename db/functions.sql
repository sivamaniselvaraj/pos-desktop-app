-- ============================================================================
-- RPC: get_order_with_items(p_order_id)
-- ============================================================================
-- Returns a single order (by its UUID id) with its line items and outlet info
-- nested in the response, as one JSON object.
--
-- Call it from the client with:
--   const { data, error } = await supabase.rpc('get_order_with_items', {
--     p_order_id: '550e8400-e29b-41d4-a716-446655440000',
--   });
--
-- Response shape:
--   {
--     id, order_id, order_number, ..., table_number, placed_by_name,
--     outlet: { id, name, city, phone, gst_number, address },
--     items: [ { id, status, quantity, unit_price, total_price, name }, ... ]
--   }
--
-- placed_by_name: the staff member who placed the order (orders.waiter_id ->
-- profiles.full_name), printed as "Placed By: <name>" on the KOT — see
-- printKot() in src/main/printerManager.ts. Null when waiter_id is null
-- (orders from before this existed, or with no resolvable staff login).
--
-- SECURITY DEFINER: the function runs with owner privileges, so the print
-- path (anon key, no user session) can fetch an order even with RLS enabled,
-- without exposing broad table-level SELECT. The only capability is "fetch
-- one order if you know its exact id".

create or replace function get_order_with_items(p_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
select to_jsonb(o)
  || jsonb_build_object('table_number', tbls.table_number)
  || jsonb_build_object('placed_by_name', wp.full_name)
  || jsonb_build_object(
    'outlet',
    (select to_jsonb(out) from outlets out where out.id = o.outlet_id)
  )
  || jsonb_build_object(
    'items',
    coalesce(
      (
        select jsonb_agg(
          (select to_jsonb(item_cols) from
            (select oi.id, oi.status, oi.quantity, oi.unit_price, oi.total_price, mi.name)
            item_cols
          )
        )
        from order_items oi
        join menu_items mi on mi.id = oi.menu_item_id
        where oi.order_id = o.id
      ),
      '[]'::jsonb
    )
  )
from orders o
left join tables tbls on tbls.id = o.table_id
left join profiles wp on wp.id = o.waiter_id
where o.id = p_order_id
  and caller_may_access_outlet(o.outlet_id);
$$;

-- Allow API roles to call it.
grant execute on function get_order_with_items(uuid) to anon, authenticated;

-- Indexes for performance.
create index if not exists idx_order_items_order_id on order_items (order_id);
create index if not exists idx_orders_outlet_id on orders (outlet_id);


-- ============================================================================
-- RPC: get_pending_kot_items(p_order_id)
-- ============================================================================
-- Returns the order's line items that have NOT yet been sent to the kitchen
-- (kot_printed = false) — i.e. the delta to print on the next confirm/KOT.
-- Joined to menu_items for the display name. Ordered by creation so the KOT
-- lists items in the order they were added.
--
-- Consumed by fetchUnprintedItems() in supabaseClient. Call with:
--   supabase.rpc('get_pending_kot_items', { p_order_id: '<order uuid>' })

create or replace function get_pending_kot_items(p_order_id uuid)
returns table (
  id uuid,
  menu_item_id uuid,
  name text,
  quantity integer,
  unit_price numeric,
  total_price numeric,
  status text,
  special_instructions text,
  kot_printed boolean,
  kot_printed_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    oi.id,
    oi.menu_item_id,
    mi.name,
    oi.quantity,
    oi.unit_price,
    oi.total_price,
    oi.status,
    oi.special_instructions,
    oi.kot_printed,
    oi.kot_printed_at
  from order_items oi
  join menu_items mi on mi.id = oi.menu_item_id
  where oi.order_id = p_order_id
    and oi.kot_printed = false
    and caller_may_access_outlet((select ord.outlet_id from orders ord where ord.id = p_order_id))
  order by oi.created_at nulls last, oi.id;
$$;

grant execute on function get_pending_kot_items(uuid) to anon, authenticated;

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


-- ============================================================================
-- RPC: mark_kot_printed(p_item_ids)   [PRIMARY]
-- ============================================================================
-- Stamp specific line-item rows as sent to the kitchen. Pass the exact ids
-- that were just printed on the KOT (from get_pending_kot_items). This is the
-- safe primitive: it never stamps rows that weren't on the printed ticket, so
-- an item added between fetching the delta and stamping it stays pending and
-- reaches the kitchen on the next confirm.
--
-- Returns the number of rows updated. Only flips rows still unprinted, so a
-- repeat call is idempotent (0 rows the second time).
--
-- Consumed by markItemsKotPrinted() in supabaseClient. Call with:
--   supabase.rpc('mark_kot_printed', { p_item_ids: ['<uuid>', ...] })

create or replace function mark_kot_printed(p_item_ids uuid[])
returns integer
language sql
security definer
set search_path = public
as $$
  with updated as (
    update order_items
       set kot_printed = true,
           kot_printed_at = now()
     where id = any(p_item_ids)
       and kot_printed = false
       and caller_may_access_outlet((select ord.outlet_id from orders ord where ord.id = order_items.order_id))
    returning 1
  )
  select count(*)::integer from updated;
$$;

grant execute on function mark_kot_printed(uuid[]) to anon, authenticated;


-- ============================================================================
-- RPC: mark_order_kot_printed(p_order_id)   [convenience]
-- ============================================================================
-- Stamp ALL currently-unprinted items of an order as sent to the kitchen.
--
-- WARNING: only safe when nothing can add items concurrently. If an item is
-- inserted between printing the KOT and calling this, that item is marked
-- printed WITHOUT having appeared on any ticket and the kitchen never sees it.
-- Prefer mark_kot_printed(p_item_ids) which stamps only the printed rows.
--
-- Returns the ids of the rows that were stamped (empty set if none).

create or replace function mark_order_kot_printed(p_order_id uuid)
returns setof uuid
language sql
security definer
set search_path = public
as $$
  update order_items
     set kot_printed = true,
         kot_printed_at = now()
   where order_id = p_order_id
     and kot_printed = false
     and caller_may_access_outlet((select ord.outlet_id from orders ord where ord.id = p_order_id))
  returning id;
$$;

grant execute on function mark_order_kot_printed(uuid) to anon, authenticated;


-- ============================================================================
-- RPC: get_sales_report(...) — SUPERSEDED, see get_sales_report_uid below
-- ============================================================================
-- The original version below assumed profiles.id = auth.users.id directly.
-- In the real schema, profiles has a separate user_id column that references
-- auth.users — so `join profiles p on p.id = auth.uid()` never matched any
-- row, and the function silently returned empty results regardless of the
-- caller's actual role/outlet/data. Dropped in favor of get_sales_report_uid,
-- which also switched bucketing from settled_at to created_at and the closed-
-- order status from 'settled' to 'completed' to match the real orders table.

drop function if exists get_sales_report(date, date, text);


-- ============================================================================
-- RPC: get_sales_report_uid(p_from, p_to, p_bucket)
-- ============================================================================
-- Completed orders in the caller's outlet for the given date range,
-- aggregated by day or month (p_bucket = 'day' | 'month', default 'day').
-- Results are grouped by bucket only — one row per day/month, never per
-- order. Bucketing uses the caller's outlet local time (my_timezone(), default Asia/Kolkata) so a late-night order lands
-- in the correct business day rather than shifting across the UTC boundary.
--
-- Buckets by created_at (order-placed time), not a settlement timestamp —
-- confirmed as the intended semantics for this report.
--
-- p_bucket only feeds a CASE expression below (never concatenated into SQL),
-- so there's no injection surface from it; any value other than 'month' is
-- treated as 'day'.
--
-- Outlet and role are resolved from auth.uid() via profiles.user_id (NOT
-- profiles.id — that was the bug in the original version above), not from a
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
  select
    date_trunc(
      case when p_bucket = 'month' then 'month' else 'day' end,
      (o.created_at at time zone (select my_timezone()))
    )::date as bucket_date,
    count(*)::bigint as order_count,
    sum(o.tax_amount) as tax_total,
    sum(o.total_amount) as net_total,
    round((sum(o.total_amount) / count(*))::numeric, 2) as avg_order_value
  from orders o
  join profiles p on p.user_id = auth.uid()
  where has_permission('reports.view')
    and p.outlet_id is not null
    and o.outlet_id = p.outlet_id
    and o.status = 'completed'
    and (o.created_at at time zone (select my_timezone()))::date between p_from and p_to
  group by 1
  order by 1;
$$;

grant execute on function get_sales_report_uid(date, date, text) to authenticated;


-- ============================================================================
-- RPC: get_top_items(p_from, p_to, p_limit)
-- ============================================================================
-- Top-selling items (by quantity sold) in the caller's outlet for the given
-- date range, from completed orders only. Same auth.uid()-via-profiles.user_id
-- resolution and role gate as get_sales_report_uid.
--
-- NOTE: order_items/menu_items column names (oi.quantity, oi.total_price,
-- oi.menu_item_id, mi.name) have NOT been verified against the real schema
-- the way orders/profiles columns were — if this also returns empty/errors,
-- check those column names next using the same approach (confirm real names,
-- fix here).

create or replace function get_top_items(p_from date, p_to date, p_limit integer default 10)
returns table (
  menu_item_id uuid,
  name text,
  quantity_sold bigint,
  revenue numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    mi.id as menu_item_id,
    mi.name,
    sum(oi.quantity)::bigint as quantity_sold,
    sum(oi.total_price) as revenue
  from order_items oi
  join orders o on o.id = oi.order_id
  join menu_items mi on mi.id = oi.menu_item_id
  join profiles p on p.user_id = auth.uid()
  where has_permission('reports.view')
    and p.outlet_id is not null
    and o.outlet_id = p.outlet_id
    and o.status = 'completed'
    and (o.created_at at time zone (select my_timezone()))::date between p_from and p_to
  group by mi.id, mi.name
  order by quantity_sold desc
  limit p_limit;
$$;

grant execute on function get_top_items(date, date, integer) to authenticated;

-- Supports both report RPCs.
create index if not exists idx_orders_outlet_status_created
  on orders (outlet_id, status, created_at);


-- ============================================================================
-- USER MANAGEMENT RPCs
-- ============================================================================
-- All gated on the caller being role = 'admin', resolved via
-- profiles.user_id = auth.uid() (the confirmed real join — see
-- get_sales_report_uid above for why profiles.id is wrong here).
--
-- list_users() is read-only and silently returns empty for a non-admin
-- caller, matching the report RPCs' convention. update_user_profile() and
-- set_user_active() are MUTATIONS — a silent no-op there would be actively
-- misleading (an admin thinking they deactivated someone when nothing
-- happened), so those raise an exception instead.
--
-- User CREATION is not here — creating a login requires Supabase's Auth
-- Admin API (to set a password), which only works with the service_role
-- key from application code, not from a SQL function. See userAdmin.ts.

-- ---------------------------------------------------------------------------
-- is_admin(): fast boolean gate, reusable by application code before any
-- privileged action that bypasses RLS (e.g. before using the service_role
-- key to create a user) and therefore needs its own check.
-- ---------------------------------------------------------------------------
create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles p where p.user_id = auth.uid() and has_permission('users.manage')
  );
$$;

grant execute on function is_admin() to authenticated;


-- ---------------------------------------------------------------------------
-- list_users(): every profile, regardless of is_active, across ALL outlets —
-- a global admin view, not outlet-scoped like the sales report RPCs.
-- ---------------------------------------------------------------------------
create or replace function list_users()
returns table (
  user_id uuid,
  email text,
  full_name text,
  phone text,
  role text,
  is_active boolean,
  outlet_id uuid,
  outlet_name text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  -- Only users of the CALLER's organization, and only for a caller who may manage users.
  select
    pr.user_id,
    pr.email,
    pr.full_name,
    pr.phone,
    pr.role,
    pr.is_active,
    pr.outlet_id,
    o.name as outlet_name,
    pr.created_at
  from profiles pr
  left join outlets o on o.id = pr.outlet_id
  where has_permission('users.manage')
    and pr.org_id = current_org_id()
  order by pr.full_name nulls last, pr.email;
$$;

grant execute on function list_users() to authenticated;


-- ---------------------------------------------------------------------------
-- update_user_profile(): admin edits another user's profile fields.
-- Deliberately does NOT touch email or password — changing the login itself
-- goes through the Auth Admin API (application code), not this function.
-- ---------------------------------------------------------------------------
create or replace function update_user_profile(
  p_user_id uuid,
  p_full_name text,
  p_phone text,
  p_role text,
  p_outlet_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := current_org_id();
  v_current_role text;
begin
  if not has_permission('users.manage') or v_org is null then
    raise exception 'Only admins can update user profiles';
  end if;
  if p_role is null or p_role not in ('staff', 'manager', 'owner', 'admin', 'editor') then
    raise exception 'Unknown role';
  end if;

  select pr.role into v_current_role
    from profiles pr
   where pr.user_id = p_user_id and pr.org_id = v_org;
  if not found then
    raise exception 'User not found in your organization';
  end if;
  if p_user_id = auth.uid() and p_role is distinct from v_current_role then
    raise exception 'You cannot change your own role';
  end if;
  if p_outlet_id is not null
     and not exists (select 1 from outlets o where o.id = p_outlet_id and o.org_id = v_org) then
    raise exception 'That outlet does not belong to your organization';
  end if;

  update profiles
     set full_name = p_full_name,
         phone = p_phone,
         role = p_role,
         outlet_id = p_outlet_id
   where user_id = p_user_id and org_id = v_org;
end;
$$;

grant execute on function update_user_profile(uuid, text, text, text, uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- set_user_active(): soft delete (false) / reactivate (true). Never removes
-- the profile row or the underlying auth login.
-- ---------------------------------------------------------------------------
create or replace function set_user_active(p_user_id uuid, p_is_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := current_org_id();
begin
  if not has_permission('users.manage') or v_org is null then
    raise exception 'Only admins can change user status';
  end if;
  if p_user_id = auth.uid() and not p_is_active then
    raise exception 'You cannot deactivate your own account';
  end if;

  update profiles set is_active = p_is_active
   where user_id = p_user_id and org_id = v_org;
  if not found then
    raise exception 'User not found in your organization';
  end if;
end;
$$;

grant execute on function set_user_active(uuid, boolean) to authenticated;


-- ============================================================================
-- USER GROUPS: admin functions (users.manage, own organization only)
-- ============================================================================
-- A group bundles permissions. Access comes ONLY from groups (admins always pass).
-- See the USER GROUPS section of db/schema.sql.

create or replace function list_groups()
returns table (id uuid, name text, description text, member_count bigint, permissions text[])
language sql
stable
security definer
set search_path = public
as $$
  select g.id, g.name, g.description,
         (select count(*) from user_group_members m where m.group_id = g.id),
         coalesce((select array_agg(gp.permission_code order by gp.permission_code)
                     from group_permissions gp where gp.group_id = g.id), '{}')
  from user_groups g
  where has_permission('users.manage') and g.org_id = current_org_id()
  order by g.name;
$$;
grant execute on function list_groups() to authenticated;

-- Create (p_id null) or update a group and replace its permission list.
create or replace function save_group(p_id uuid, p_name text, p_description text, p_permissions text[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := current_org_id();
  v_id uuid := p_id;
  v_name text := btrim(coalesce(p_name, ''));
  v_perms text[] := coalesce(p_permissions, '{}');
begin
  if not has_permission('users.manage') or v_org is null then
    raise exception 'Only admins can manage groups';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 60 then
    raise exception 'Group name must be 1 to 60 characters';
  end if;
  if exists (select 1 from unnest(v_perms) c where not exists (select 1 from permissions pm where pm.code = c)) then
    raise exception 'Unknown permission in the list';
  end if;

  if v_id is null then
    insert into user_groups (org_id, name, description)
    values (v_org, v_name, coalesce(p_description, ''))
    returning id into v_id;
  else
    update user_groups set name = v_name, description = coalesce(p_description, '')
     where id = v_id and org_id = v_org;
    if not found then
      raise exception 'Group not found in your organization';
    end if;
  end if;

  delete from group_permissions where group_id = v_id;
  insert into group_permissions (group_id, permission_code)
  select v_id, c from (select distinct unnest(v_perms) as c) x;
  return v_id;
exception when unique_violation then
  raise exception 'A group named "%" already exists', v_name;
end;
$$;
grant execute on function save_group(uuid, text, text, text[]) to authenticated;

create or replace function delete_group(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not has_permission('users.manage') then
    raise exception 'Only admins can manage groups';
  end if;
  delete from user_groups where id = p_id and org_id = current_org_id();
  if not found then
    raise exception 'Group not found in your organization';
  end if;
end;
$$;
grant execute on function delete_group(uuid) to authenticated;

-- Every (user, group) pair of the caller's organization, for the Users table.
create or replace function list_group_memberships()
returns table (user_id uuid, group_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select m.user_id, m.group_id
  from user_group_members m
  join user_groups g on g.id = m.group_id
  join profiles p on p.user_id = m.user_id and p.org_id = g.org_id
  where has_permission('users.manage') and g.org_id = current_org_id();
$$;
grant execute on function list_group_memberships() to authenticated;

-- Replace a group's members.
create or replace function set_group_members(p_group_id uuid, p_user_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := current_org_id();
  v_ids uuid[] := coalesce(p_user_ids, '{}');
begin
  if not has_permission('users.manage') or v_org is null then
    raise exception 'Only admins can manage groups';
  end if;
  if not exists (select 1 from user_groups where id = p_group_id and org_id = v_org) then
    raise exception 'Group not found in your organization';
  end if;
  if exists (select 1 from unnest(v_ids) u
              where not exists (select 1 from profiles p where p.user_id = u and p.org_id = v_org)) then
    raise exception 'A selected user is not in your organization';
  end if;

  delete from user_group_members where group_id = p_group_id;
  insert into user_group_members (group_id, user_id, added_by)
  select p_group_id, u, auth.uid() from (select distinct unnest(v_ids) as u) x;
end;
$$;
grant execute on function set_group_members(uuid, uuid[]) to authenticated;

-- Replace the groups of one user.
create or replace function set_user_groups(p_user_id uuid, p_group_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := current_org_id();
  v_ids uuid[] := coalesce(p_group_ids, '{}');
begin
  if not has_permission('users.manage') or v_org is null then
    raise exception 'Only admins can manage groups';
  end if;
  if not exists (select 1 from profiles p where p.user_id = p_user_id and p.org_id = v_org) then
    raise exception 'User not found in your organization';
  end if;
  if exists (select 1 from unnest(v_ids) g
              where not exists (select 1 from user_groups x where x.id = g and x.org_id = v_org)) then
    raise exception 'A selected group is not in your organization';
  end if;

  delete from user_group_members m
   using user_groups g
   where m.group_id = g.id and g.org_id = v_org and m.user_id = p_user_id;
  insert into user_group_members (group_id, user_id, added_by)
  select g, p_user_id, auth.uid() from (select distinct unnest(v_ids) as g) x;
end;
$$;
grant execute on function set_user_groups(uuid, uuid[]) to authenticated;

-- What a user can do and why: one row per permission with its source
-- ('role' or the group names). Admins get every permission via the role.
create or replace function user_effective_access(p_user_id uuid)
returns table (permission_code text, via text[])
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := current_org_id();
  v_role text;
begin
  if not has_permission('users.manage') or v_org is null then
    raise exception 'Only admins can view user access';
  end if;
  select p.role into v_role from profiles p where p.user_id = p_user_id and p.org_id = v_org;
  if not found then
    raise exception 'User not found in your organization';
  end if;

  return query
  select pm.code,
         (case when v_role = 'admin' then array['admin'] else '{}'::text[] end)
         || coalesce((select array_agg('group: ' || g.name order by g.name)
                        from user_group_members m
                        join user_groups g on g.id = m.group_id and g.org_id = v_org
                        join group_permissions gp on gp.group_id = g.id and gp.permission_code = pm.code
                       where m.user_id = p_user_id), '{}'::text[])
  from permissions pm
  order by pm.code;
end;
$$;
grant execute on function user_effective_access(uuid) to authenticated;


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
-- without erroring. `base` now falls back to a 20-day window in exactly
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
-- Status rule (best outcome across the invoice's rounds): 'open' if ANY order
-- is neither cancelled nor completed (still in progress); else 'completed' if
-- ANY order completed; else (every round cancelled) the latest round's status,
-- i.e. 'cancelled'. So a table with 2 completed rounds + 1 cancelled round is
-- 'completed', not 'cancelled'. cancelled_count reports how many rounds of the
-- invoice are cancelled so the UI can badge a partial cancel, and the
-- 'cancelled' filter matches any invoice that has at least one cancelled round.
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
      and has_permission('orders.view')
      and p.outlet_id = p_outlet_id
  ),
  cand as (
    select o.id as order_id, o.order_type, o.created_at, o.table_id, o.invoice_number,
           o.outlet_id, g.order_count, g.cancelled_count, g.status
    from caller c
    join orders o on o.outlet_id = c.outlet_id
    cross join lateral (
      select count(*)::integer as order_count,
             (count(*) filter (where m.status = 'cancelled'))::integer as cancelled_count,
             case when bool_or(m.status not in ('cancelled', 'completed')) then 'open'
                  when bool_or(m.status = 'completed') then 'completed'
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
           or o.id in (
                select s.id from orders s
                where s.outlet_id = p_outlet_id
                  and s.id::text ilike '%' || p_search || '%')
           or o.invoice_number in (
                select s.invoice_number from orders s
                where s.outlet_id = p_outlet_id
                  and s.id::text ilike '%' || p_search || '%'))
      and (p_status is null
           or (p_status = 'active' and g.status = 'open')
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
      coalesce(sum(m.subtotal_amount) filter (where m.status <> 'cancelled'), 0) as subtotal_amount,
      coalesce(sum(m.tax_amount) filter (where m.status <> 'cancelled'), 0) as tax_amount,
      coalesce(sum(m.container_charge_amount) filter (where m.status <> 'cancelled'), 0) as container_charge_amount,
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
    p.order_count,
    p.cancelled_count,
    p.fetched::bigint as total_rows
  from paged p
  left join totals t on t.anchor_id = p.order_id
  left join tables tb on tb.id = p.table_id
  order by p.created_at desc;
$$;

grant execute on function list_orders(uuid, text, text, date, date, integer, integer) to authenticated;


-- ============================================================================
-- recompute_order_totals(): shared tax/container-charge/total formula
-- ============================================================================
-- subtotal    = sum(quantity * unit_price) over non-deleted items
-- container_charge_amount = pickup orders only (0 for dine-in/delivery):
--                 round(sum(quantity * unit_price * menu_items.container_charge / 100), 2)
--                 over non-deleted items. menu_items.container_charge is a
--                 PERCENTAGE of the line total; it is read from the menu at
--                 recompute time, so an edit made after the menu's
--                 percentage changed uses the new percentage.
-- tax_amount  = round((subtotal + container_charge_amount) * rate / 100, 2)
--                 rate = rate_percent of the newest active tax_settings row
--                 for the order's outlet. If the outlet has none the rate is
--                 0, matching the New Order page (which warns in that case).
--                 For dine-in the container charge is 0, so tax is on the
--                 subtotal alone.
-- total_amount = subtotal + container_charge_amount + tax_amount
--
-- These are the same rules as src/shared/orderTotals.ts (New Order page).
--
-- Deliberately excludes any "discount" column — it was never confirmed to
-- exist on the real orders table (dropped from the report RPCs earlier for
-- the same reason) and guessing a discount formula risks the same class of
-- silent-wrong-number bug as the tax/total column-name mismatch this same
-- change fixes in mapRow() (see supabaseClient.ts).
--
-- Internal helper only — EXECUTE is revoked from public/authenticated below
-- so it can't be called directly, bypassing the auth checks that
-- edit_order_item / delete_order_item perform before calling this.
create or replace function recompute_order_totals(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_subtotal numeric;
  v_order_type text;
  v_outlet_id uuid;
  v_container_charge numeric := 0;
  v_rate numeric := 0;
  v_tax numeric;
begin
  select o.order_type, o.outlet_id
    into v_order_type, v_outlet_id
  from orders o
  where o.id = p_order_id;

  select coalesce(sum(oi.quantity * oi.unit_price), 0)
    into v_subtotal
  from order_items oi
  where oi.order_id = p_order_id and not oi.is_deleted;

  if v_order_type = 'pickup' then
    select round(coalesce(sum(oi.quantity * oi.unit_price * coalesce(mi.container_charge, 0) / 100), 0), 2)
      into v_container_charge
    from order_items oi
    left join menu_items mi on mi.id = oi.menu_item_id
    where oi.order_id = p_order_id and not oi.is_deleted;
  end if;

  select coalesce(
           (select ts.rate_percent
              from tax_settings ts
             where ts.outlet_id = v_outlet_id
               and ts.is_active
             order by ts.updated_at desc
             limit 1),
           0)
    into v_rate;

  v_tax := round((v_subtotal + v_container_charge) * v_rate / 100, 2);

  update orders
     set subtotal_amount = v_subtotal,
         tax_amount = v_tax,
         container_charge_amount = v_container_charge,
         total_amount = v_subtotal + v_container_charge + v_tax
   where id = p_order_id;
end;
$$;

revoke execute on function recompute_order_totals(uuid) from public;


-- ---------------------------------------------------------------------------
-- EDITOR APPROVAL (second factor for edit / delete / cancel)
-- ---------------------------------------------------------------------------
-- edit_order_item(), delete_order_item() and cancel_order() each require the
-- username (email) + password of a DIFFERENT account whose profile role is
-- 'editor' (same outlet, active) on EVERY call — there is no remembered
-- approval. The check lives here, inside the same transaction as the change,
-- so it cannot be skipped by calling the RPCs directly.
--
-- Passwords are verified against auth.users.encrypted_password with
-- pgcrypto's crypt() (Supabase stores bcrypt there). This never creates a
-- session or touches the signed-in user's login.
--
-- Failed attempts are logged and throttled: 5 failures for the same username
-- in 10 minutes locks that editor account out of approvals for the rest of
-- the window. A wrong/locked/unknown credential RETURNS an error object
-- instead of raising — raising would roll back the very row that records the
-- failed attempt, defeating the throttle. Callers therefore return jsonb
-- {ok:false,error} for credential problems (and still raise for
-- authorization problems, which are checked BEFORE credentials so an
-- unauthorized caller can't use this to guess editor passwords).
--
-- Internal helper: EXECUTE is revoked from everyone; only the security-
-- definer RPCs below call it.
drop function if exists verify_editor_approval(uuid, text, text);

create or replace function verify_editor_approval(
  p_outlet_id uuid,
  p_username text,
  p_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user text := lower(trim(coalesce(p_username, '')));
  v_id uuid;
  v_email text;
  v_hash text;
  v_failures integer;
begin
  if v_user = '' or p_password is null or p_password = '' then
    return jsonb_build_object('error', 'Editor username and password are required');
  end if;

  select count(*) into v_failures
  from editor_approval_attempts a
  where a.outlet_id = p_outlet_id
    and lower(a.username) = v_user
    and not a.succeeded
    and a.attempted_at > now() - interval '10 minutes';

  if v_failures >= 5 then
    return jsonb_build_object('error',
      'Too many failed attempts for this editor account. Try again in a few minutes.');
  end if;

  select u.id, u.email, u.encrypted_password
    into v_id, v_email, v_hash
  from auth.users u
  join profiles pr on pr.user_id = u.id
  where lower(u.email) = v_user
    and pr.role = 'editor'
    and pr.is_active
    and pr.outlet_id = p_outlet_id;

  if v_id is not null and v_hash is not null and crypt(p_password, v_hash) = v_hash then
    delete from editor_approval_attempts
     where outlet_id = p_outlet_id and lower(username) = v_user and not succeeded;
    insert into editor_approval_attempts (outlet_id, username, requested_by, succeeded)
    values (p_outlet_id, v_user, auth.uid(), true);
    return jsonb_build_object('editor_id', v_id, 'editor_email', v_email);
  end if;

  -- Unknown user / not an editor / wrong password all look identical to the
  -- caller. Burn a comparable amount of time when the user wasn't found so
  -- response timing doesn't reveal which usernames exist.
  if v_id is null then
    perform crypt(p_password, gen_salt('bf'));
  end if;

  insert into editor_approval_attempts (outlet_id, username, requested_by, succeeded)
  values (p_outlet_id, v_user, auth.uid(), false);
  return jsonb_build_object('error', 'Invalid editor username or password');
end;
$$;

revoke execute on function verify_editor_approval(uuid, text, text) from public;
revoke execute on function verify_editor_approval(uuid, text, text) from authenticated;


-- ---------------------------------------------------------------------------
-- NOTE: src/main/ordersListManager.ts now reads the item/order with plain
-- .from('order_items')/.from('orders') SELECTs first (easier to see/debug
-- than an opaque rpc() call — see assertItemEditable() there), gated by the
-- "staff read own outlet order items/orders" RLS policies in db/schema.sql.
-- The actual write — update + audit insert + totals recompute — still comes
-- through edit_order_item()/delete_order_item() below, unchanged: those
-- three writes need to succeed or fail together, which one security-definer
-- function call gives for free and several separate client requests don't.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- edit_order_item(): change QUANTITY only on one line item — price is not
-- editable (see below). Every edit is
-- audited (before/after snapshot + who/when/optional reason), and
-- subtotal/tax/container-charge/total are all recomputed immediately via
-- recompute_order_totals().
--
-- Only allowed while the parent order is still 'open' — an order that's
-- completed or cancelled is locked. ("active and preparing" read as
-- describing that single not-yet-finalized state; there's no confirmed
-- distinct 'preparing' status in the real schema — if one exists, broaden
-- the check below.)
-- ---------------------------------------------------------------------------
-- The old 4-arg signature (uuid, integer, numeric, text) allowed changing
-- unit_price too. Price editing is intentionally removed — only quantity is
-- editable now. Since Postgres treats a different argument list as a
-- different function, `create or replace` on the new 3-arg signature would
-- NOT replace the old one; it would sit alongside it as a second, still-
-- callable overload that still lets price be changed. Drop it explicitly.
drop function if exists edit_order_item(uuid, integer, numeric, text);
drop function if exists edit_order_item(uuid, integer, text);
drop function if exists edit_order_item(uuid, uuid, integer, text);

-- p_outlet_id (passed from the desktop app's config.outletId, like
-- list_orders()) is now the first, required argument. The caller's profile
-- must still be manager/owner/admin AND belong to that same outlet, and the
-- order must belong to it too — passing another outlet's id just fails the
-- same "not authorized" check, it never grants cross-outlet access.
-- p_reason is now mandatory (was optional): app_activity_log.reason is NOT
-- NULL, and the UI already refuses to save an edit without one.
-- Every successful edit is written to BOTH order_item_audit (what the
-- Orders List activity log reads) and app_activity_log (the outlet-wide
-- activity trail), inside the same transaction as the edit itself.
create or replace function edit_order_item(
  p_outlet_id uuid,
  p_order_item_id uuid,
  p_quantity integer,
  p_reason text,
  p_editor_username text,
  p_editor_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_old jsonb;
  v_new jsonb;
  v_order jsonb;
  v_approval jsonb;
begin
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A reason is required to edit an order item';
  end if;

  select oi.order_id, to_jsonb(oi.*)
    into v_order_id, v_old
  from order_items oi
  join orders o on o.id = oi.order_id
  join profiles p on p.user_id = auth.uid()
  where oi.id = p_order_item_id
    and has_permission('orders.edit')
    and p.outlet_id = p_outlet_id
    and o.outlet_id = p_outlet_id
    and o.status = 'open';

  if v_order_id is null then
    raise exception 'Not authorized, item not found, or the order is not editable in its current status';
  end if;

  -- Second factor: an 'editor' account's username + password, every call.
  -- Checked only AFTER the caller proved authorized above (see
  -- verify_editor_approval). A bad credential returns, not raises, so the
  -- failed-attempt row survives; nothing has been modified yet at this point.
  v_approval := verify_editor_approval(p_outlet_id, p_editor_username, p_editor_password);
  if v_approval ? 'error' then
    return jsonb_build_object('ok', false, 'error', v_approval->>'error');
  end if;

  -- unit_price is deliberately NOT in the SET list. Referencing it on the
  -- right-hand side still reads the row's current (pre-update) value, so
  -- total_price recomputes correctly from the existing price × new quantity.
  update order_items
     set quantity = p_quantity,
         total_price = p_quantity * unit_price,
         edited_at = now(),
         edited_by = auth.uid()
   where id = p_order_item_id
   returning to_jsonb(order_items.*) into v_new;

  insert into order_item_audit (order_item_id, order_id, action, changed_by, old_values, new_values)
  values (
    p_order_item_id, v_order_id, 'edit', auth.uid(),
    v_old, v_new || jsonb_build_object('reason', p_reason,
                                       'approved_by', v_approval->>'editor_email')
  );

  perform recompute_order_totals(v_order_id);

  select jsonb_build_object(
           'order_number', o.order_number, 'invoice_number', o.invoice_number,
           'table_id', o.table_id, 'order_type', o.order_type,
           'status', o.status, 'total_amount', o.total_amount,
           'item_name', v_old->>'name',
           'old_item', v_old, 'new_item', v_new,
           'approved_by', v_approval->>'editor_email',
           'approved_by_id', v_approval->>'editor_id')
    into v_order
  from orders o where o.id = v_order_id;

  insert into app_activity_log
    (order_id, order_item_id, old_quantity, new_quantity, changed_by, changed_at,
     created_at, order_details, reason, activity)
  values (
    v_order_id, p_order_item_id,
    (v_old->>'quantity')::numeric, (v_new->>'quantity')::numeric,
    auth.uid(), now(), now(), v_order::json, trim(p_reason), 'edit_item'
  );

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function edit_order_item(uuid, uuid, integer, text, text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- delete_order_item(): soft delete only — never removes the row. Same audit,
-- 'open'-only restriction, and totals recompute as edit_order_item.
-- ---------------------------------------------------------------------------
drop function if exists delete_order_item(uuid, text);
drop function if exists delete_order_item(uuid, uuid, text);

-- Same outlet-parameter / mandatory-reason / dual-audit-write rules as
-- edit_order_item above.
create or replace function delete_order_item(
  p_outlet_id uuid,
  p_order_item_id uuid,
  p_reason text,
  p_editor_username text,
  p_editor_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_old jsonb;
  v_new jsonb;
  v_order jsonb;
  v_approval jsonb;
begin
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A reason is required to remove an order item';
  end if;

  select oi.order_id, to_jsonb(oi.*)
    into v_order_id, v_old
  from order_items oi
  join orders o on o.id = oi.order_id
  join profiles p on p.user_id = auth.uid()
  where oi.id = p_order_item_id
    and has_permission('orders.edit')
    and p.outlet_id = p_outlet_id
    and o.outlet_id = p_outlet_id
    and o.status = 'open';

  if v_order_id is null then
    raise exception 'Not authorized, item not found, or the order is not editable in its current status';
  end if;

  -- Second factor — see edit_order_item / verify_editor_approval.
  v_approval := verify_editor_approval(p_outlet_id, p_editor_username, p_editor_password);
  if v_approval ? 'error' then
    return jsonb_build_object('ok', false, 'error', v_approval->>'error');
  end if;

  update order_items
     set is_deleted = true,
         edited_at = now(),
         edited_by = auth.uid()
   where id = p_order_item_id
   returning to_jsonb(order_items.*) into v_new;

  insert into order_item_audit (order_item_id, order_id, action, changed_by, old_values, new_values)
  values (
    p_order_item_id, v_order_id, 'delete', auth.uid(),
    v_old, v_new || jsonb_build_object('reason', p_reason,
                                       'approved_by', v_approval->>'editor_email')
  );

  perform recompute_order_totals(v_order_id);

  select jsonb_build_object(
           'order_number', o.order_number, 'invoice_number', o.invoice_number,
           'table_id', o.table_id, 'order_type', o.order_type,
           'status', o.status, 'total_amount', o.total_amount,
           'item_name', v_old->>'name',
           'old_item', v_old, 'new_item', v_new,
           'approved_by', v_approval->>'editor_email',
           'approved_by_id', v_approval->>'editor_id')
    into v_order
  from orders o where o.id = v_order_id;

  -- new_quantity is null for a delete: the line no longer contributes.
  insert into app_activity_log
    (order_id, order_item_id, old_quantity, new_quantity, changed_by, changed_at,
     created_at, order_details, reason, activity)
  values (
    v_order_id, p_order_item_id,
    (v_old->>'quantity')::numeric, null,
    auth.uid(), now(), now(), v_order::json, trim(p_reason), 'delete_item'
  );

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function delete_order_item(uuid, uuid, text, text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- cancel_order(): mandatory reason, manager/owner/admin only. Frees the
-- table ONLY if no other still-open order remains on it — a table can now
-- carry several dine-in orders at once (separate rounds), and cancelling one
-- of them must not release a table that's still active for the others. See
-- complete_order()/save_order_payment() below for the matching table-batch
-- model. Raises if the reason is missing/blank — cancellation is a
-- fraud-sensitive action and must never happen silently or without a reason.
-- ---------------------------------------------------------------------------
drop function if exists cancel_order(uuid, text);
drop function if exists cancel_order(uuid, uuid, text);

-- p_outlet_id: same explicit-outlet rule as edit_order_item/list_orders —
-- caller must be manager/owner/admin of THAT outlet and the order must
-- belong to it. The cancellation is also recorded in app_activity_log.
create or replace function cancel_order(
  p_outlet_id uuid,
  p_order_id uuid,
  p_reason text,
  p_editor_username text,
  p_editor_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table_id uuid;
  v_order jsonb;
  v_approval jsonb;
begin
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A reason is required to cancel an order';
  end if;

  if not exists (
    select 1 from orders o
    join profiles p on p.user_id = auth.uid()
    where o.id = p_order_id
      and has_permission('orders.cancel')
      and p.outlet_id = p_outlet_id
      and o.outlet_id = p_outlet_id
  ) then
    raise exception 'Not authorized, or order not found';
  end if;

  if exists (select 1 from orders where id = p_order_id and status = 'cancelled') then
    raise exception 'This order is already cancelled';
  end if;
  if exists (select 1 from orders where id = p_order_id and payment_details is not null) then
    raise exception 'Payment is already recorded for this order, so it cannot be cancelled';
  end if;

  -- Second factor — see edit_order_item / verify_editor_approval.
  v_approval := verify_editor_approval(p_outlet_id, p_editor_username, p_editor_password);
  if v_approval ? 'error' then
    return jsonb_build_object('ok', false, 'error', v_approval->>'error');
  end if;

  update orders
     set status = 'cancelled',
         cancel_reason = p_reason,
         cancelled_by = auth.uid(),
         cancelled_at = now()
   where id = p_order_id
   returning table_id into v_table_id;

  if v_table_id is not null and not exists (
    select 1 from orders
    where table_id = v_table_id
      and status not in ('completed', 'cancelled')
  ) then
    update tables set state = 'open' where id = v_table_id;
  end if;

  select jsonb_build_object(
           'order_number', o.order_number, 'invoice_number', o.invoice_number,
           'table_id', o.table_id, 'order_type', o.order_type,
           'status', o.status, 'total_amount', o.total_amount,
           'approved_by', v_approval->>'editor_email',
           'approved_by_id', v_approval->>'editor_id')
    into v_order
  from orders o where o.id = p_order_id;

  insert into app_activity_log
    (order_id, order_item_id, old_quantity, new_quantity, changed_by, changed_at,
     created_at, order_details, reason, activity)
  values (
    p_order_id, null, null, null,
    auth.uid(), now(), now(), v_order::json, trim(p_reason), 'cancel_order'
  );

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function cancel_order(uuid, uuid, text, text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- cancel_invoice(): "cancel all" for a dine-in table sitting — cancels every
-- not-yet-cancelled order (round) sharing one invoice_number in ONE
-- transaction, with ONE editor approval for the whole table. Cancelling a
-- single round stays cancel_order() above.
--
-- Same rules as cancel_order: reason required; caller must be
-- manager/owner/admin of p_outlet_id and the invoice must belong to that
-- outlet (authorization raises, and is checked BEFORE editor credentials);
-- bad credentials return {ok:false,error}. Additionally refuses if ANY round
-- already has a payment recorded — a paid sitting can't be cancelled, and
-- cancelling "all but the paid one" would leave a half-cancelled invoice.
-- Settled-but-unpaid (completed) rounds ARE cancelled along with open ones.
-- Frees the table once at the end, and writes one app_activity_log row per
-- round cancelled (activity 'cancel_order', invoice + editor in
-- order_details) so the per-order trail matches single cancels.
-- ---------------------------------------------------------------------------
drop function if exists cancel_invoice(uuid, text, text, text, text);

create or replace function cancel_invoice(
  p_outlet_id uuid,
  p_invoice_number text,
  p_reason text,
  p_editor_username text,
  p_editor_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_approval jsonb;
  v_ids uuid[];
  v_table_ids uuid[];
  v_id uuid;
  v_tid uuid;
  v_order jsonb;
begin
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A reason is required to cancel an order';
  end if;

  if not exists (
    select 1 from profiles p
    where p.user_id = auth.uid()
      and has_permission('orders.cancel')
      and p.outlet_id = p_outlet_id
  ) then
    raise exception 'Not authorized, or invoice not found';
  end if;

  select array_agg(o.id order by o.order_number)
    into v_ids
  from orders o
  where o.outlet_id = p_outlet_id
    and o.invoice_number = p_invoice_number
    and o.status <> 'cancelled';

  if v_ids is null then
    raise exception 'No cancellable orders found for this invoice (already cancelled, or not found)';
  end if;

  if exists (
    select 1 from orders o
    where o.outlet_id = p_outlet_id
      and o.invoice_number = p_invoice_number
      and o.payment_details is not null
  ) then
    raise exception 'Payment is already recorded for this invoice, so it cannot be cancelled';
  end if;

  v_approval := verify_editor_approval(p_outlet_id, p_editor_username, p_editor_password);
  if v_approval ? 'error' then
    return jsonb_build_object('ok', false, 'error', v_approval->>'error');
  end if;

  select array_agg(distinct o.table_id) filter (where o.table_id is not null)
    into v_table_ids
  from orders o where o.id = any (v_ids);

  update orders
     set status = 'cancelled',
         cancel_reason = trim(p_reason),
         cancelled_by = auth.uid(),
         cancelled_at = now()
   where id = any (v_ids);

  foreach v_id in array v_ids loop
    select jsonb_build_object(
             'order_number', o.order_number, 'invoice_number', o.invoice_number,
             'table_id', o.table_id, 'order_type', o.order_type,
             'status', o.status, 'total_amount', o.total_amount,
             'cancelled_with', v_ids, 'scope', 'invoice',
             'approved_by', v_approval->>'editor_email',
             'approved_by_id', v_approval->>'editor_id')
      into v_order
    from orders o where o.id = v_id;

    insert into app_activity_log
      (order_id, order_item_id, old_quantity, new_quantity, changed_by, changed_at,
       created_at, order_details, reason, activity)
    values (v_id, null, null, null, auth.uid(), now(), now(), v_order::json,
            trim(p_reason), 'cancel_order');
  end loop;

  if v_table_ids is not null then
    foreach v_tid in array v_table_ids loop
      if not exists (
        select 1 from orders
        where table_id = v_tid and status not in ('completed', 'cancelled')
      ) then
        update tables set state = 'open' where id = v_tid;
      end if;
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'cancelled', cardinality(v_ids));
end;
$$;

grant execute on function cancel_invoice(uuid, text, text, text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- complete_order(): manual status change from the Orders List page (and the
-- same status flip the Android settle flow applies via the anon-key path in
-- src/main/supabaseClient.ts). Deliberately does NOT print here — printing
-- is its own separate action (see printOrder/isDuplicate in
-- printerManager.ts, and the settle flow in orderManager.ts).
--
-- Table grouping: a table can carry multiple separate dine-in orders at once
-- (rounds ordered separately). Completing ANY one of them completes every
-- still-open order on that same table together, so they settle and bill as
-- one batch. Pickup/delivery orders (table_id null) are unaffected — just
-- this one order completes.
--
-- Does NOT free the table — table release now happens only once payment is
-- recorded for the whole batch, via save_order_payment() below. This is a
-- deliberate change from the old "complete = table available again"
-- behavior: an order (or a table's whole batch) isn't fully done until
-- payment is recorded.
-- ---------------------------------------------------------------------------
create or replace function complete_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table_id uuid;
begin
  select o.table_id into v_table_id
  from orders o
  join profiles p on p.user_id = auth.uid()
  where o.id = p_order_id
    and has_permission('orders.complete')
    and p.outlet_id = o.outlet_id;

  if not found then
    raise exception 'Not authorized, or order not found';
  end if;

  if v_table_id is not null then
    update orders
       set status = 'completed',
           settled_at = coalesce(settled_at, now())
     where table_id = v_table_id
       and status not in ('completed', 'cancelled');
  else
    update orders
       set status = 'completed',
           settled_at = coalesce(settled_at, now())
     where id = p_order_id;
  end if;
end;
$$;

grant execute on function complete_order(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- save_order_payment(): Table Dashboard Save button. Records how a table's
-- whole settled-and-unpaid batch was paid, then frees the table.
--
-- p_order_id only needs to identify ONE order in the batch (whichever the
-- card happened to carry) — the function resolves that order's table_id and
-- applies payment to every order on the table that is 'completed' with
-- payment_details still null (i.e. the batch complete_order() just closed).
-- This mirrors complete_order()'s "whole table settles together" model: the
-- printed bill was already the merged total for all of them, so payment is
-- recorded once for the group, not per individual order.
--
-- Pickup/delivery orders (table_id null) have no batch to join, so only
-- p_order_id itself is paid.
--
-- Part-payment amounts must sum to the GROUP total (every order's
-- total_amount added together), not just p_order_id's own total.
--
-- RACE GUARD: a new dine-in round can be created on this table (Android) in
-- the narrow window between the settle-print's batch being read and this
-- payment being saved (see orderManager.ts handleSettle) — that straggler
-- order lands on the table with status still NOT 'completed'. Freeing the
-- table here would then release it while a genuinely open, unbilled order
-- still sits on it. So the table is only freed when there is no other order
-- left on it that isn't completed or cancelled — same guard cancel_order()
-- above already applies. If a straggler exists, payment for the settled
-- batch is still recorded (that money IS accounted for), the table just
-- stays locked until the straggler is itself settled and paid too.
-- ---------------------------------------------------------------------------
create or replace function save_order_payment(
  p_order_id uuid,
  p_method text, -- 'card' | 'cash' | 'upi' | 'part-payment'
  p_cash_amount numeric default null,
  p_card_amount numeric default null,
  p_upi_amount numeric default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table_id uuid;
  v_total numeric;
  v_sum numeric;
  v_recorded_at timestamptz := now();
begin
  if p_method not in ('card', 'cash', 'upi', 'part-payment') then
    raise exception 'Invalid payment method: %', p_method;
  end if;

  select o.table_id into v_table_id
  from orders o
  join profiles p on p.user_id = auth.uid()
  where o.id = p_order_id
    and has_permission('orders.complete')
    and p.outlet_id = o.outlet_id
    and o.status = 'completed';

  if not found then
    raise exception 'Not authorized, order not found, or order is not completed yet';
  end if;

  if v_table_id is not null then
    select sum(total_amount) into v_total
    from orders
    where table_id = v_table_id
      and status = 'completed'
      and payment_details is null;
  else
    select total_amount into v_total from orders where id = p_order_id;
  end if;

  if p_method = 'part-payment' then
    v_sum := coalesce(p_cash_amount, 0) + coalesce(p_card_amount, 0) + coalesce(p_upi_amount, 0);
    if round(v_sum, 2) != round(coalesce(v_total, 0), 2) then
      raise exception 'Part-payment amounts (%) do not match the order total (%)', v_sum, v_total;
    end if;
  end if;

  if v_table_id is not null then
    update orders
       set payment_details = jsonb_build_object(
         'method', p_method,
         'cashAmount', p_cash_amount,
         'cardAmount', p_card_amount,
         'upiAmount', p_upi_amount,
         'recordedAt', v_recorded_at
       )
     where table_id = v_table_id
       and status = 'completed'
       and payment_details is null;

    if not exists (
      select 1 from orders
      where table_id = v_table_id
        and status not in ('completed', 'cancelled')
    ) then
      update tables set state = 'open' where id = v_table_id;
    end if;
  else
    update orders
       set payment_details = jsonb_build_object(
         'method', p_method,
         'cashAmount', p_cash_amount,
         'cardAmount', p_card_amount,
         'upiAmount', p_upi_amount,
         'recordedAt', v_recorded_at
       )
     where id = p_order_id;
  end if;
end;
$$;

grant execute on function save_order_payment(uuid, text, numeric, numeric, numeric) to authenticated;


-- ============================================================================
-- get_order_activity_log(): "created" + every edit/delete for one order
-- ============================================================================
-- Read-only, same admin/outlet gate as the other Orders List RPCs, silently
-- empty for an unauthorized caller. Returns edit/delete events only — the
-- "Order created" entry isn't stored anywhere separately, the client
-- synthesizes it from orders.created_at (already in hand from list_orders),
-- so there's no need to fetch it here too.
--
-- old_quantity/new_quantity are typically EQUAL for a 'delete' event, since
-- delete_order_item() only flips is_deleted — it doesn't touch quantity or
-- price. The client should read a delete as "removed {new_quantity} of
-- {item_name}", not as a quantity change.
create or replace function get_order_activity_log(p_order_id uuid)
returns table (
  audit_id uuid,
  order_item_id uuid,
  item_name text,
  action text,
  changed_at timestamptz,
  changed_by_name text,
  old_quantity integer,
  new_quantity integer,
  old_unit_price numeric,
  new_unit_price numeric,
  reason text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.id as audit_id,
    a.order_item_id,
    mi.name as item_name,
    a.action,
    a.changed_at,
    coalesce(cb.full_name, cb.email, 'Unknown') as changed_by_name,
    (a.old_values ->> 'quantity')::integer as old_quantity,
    (a.new_values ->> 'quantity')::integer as new_quantity,
    (a.old_values ->> 'unit_price')::numeric as old_unit_price,
    (a.new_values ->> 'unit_price')::numeric as new_unit_price,
    a.new_values ->> 'reason' as reason
  from order_item_audit a
  join orders o on o.id = a.order_id
  join profiles p on p.user_id = auth.uid()
  join order_items oi on oi.id = a.order_item_id
  join menu_items mi on mi.id = oi.menu_item_id
  left join profiles cb on cb.user_id = a.changed_by
  where a.order_id = p_order_id
    and has_permission('orders.view')
    and p.outlet_id = o.outlet_id
  order by a.changed_at desc;
$$;

grant execute on function get_order_activity_log(uuid) to authenticated;


-- ============================================================================
-- list_tables_for_outlet() / create_table(): backs the Dashboard table-cards
-- view (src/renderer/pages/Dashboard.tsx)
-- ============================================================================
-- table_number and state were already confirmed real columns elsewhere in
-- this project (get_order_with_items' join, the settle flow). outlet_id was
-- added by the migration above this section in db/schema.sql, following the
-- same pattern every other outlet-scoped entity already uses.
--
-- table_number is cast to text in the return type deliberately — its real
-- underlying type (integer vs varchar) was never confirmed either, and text
-- works correctly for display regardless of which it actually is.
--
-- Table grouping: a table can carry several dine-in orders at once (rounds
-- ordered separately, all still under the same table number). This function
-- no longer surfaces just the single most-recent order — it surfaces the
-- whole "current batch" for the table: every order that isn't cancelled and
-- isn't both completed AND paid yet. That batch is exactly what
-- complete_order() settles together, what the settle-print flow
-- (orderManager.ts handleSettle) bills together, and what
-- save_order_payment() pays off together. Once every order in the batch has
-- payment_details set, the batch is empty and the table reads as fully
-- available again — no separate "just paid" bookkeeping needed.
--
-- order_status on the returned batch is 'open' if any order in it is still
-- unsettled, else 'completed' (settled, awaiting payment — Save button
-- shows). payment_recorded is true only once every order in the batch has
-- payment_details set (in practice this only shows true transiently, since a
-- fully-paid batch immediately drops out of the query).
drop function if exists list_tables_for_outlet();

create or replace function list_tables_for_outlet()
returns table (
  table_id uuid,
  table_number text,
  table_state text,
  order_ids uuid[],
  order_numbers int[],
  invoice_number text,
  order_status text,
  order_created_at timestamptz,
  order_total_amount numeric,
  payment_recorded boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    t.id as table_id,
    t.table_number::text as table_number,
    t.state as table_state,
    batch.order_ids,
    batch.order_numbers,
    batch.invoice_number,
    batch.order_status,
    batch.order_created_at,
    batch.order_total_amount,
    batch.payment_recorded
  from tables t
  join profiles p on p.user_id = auth.uid()
  left join lateral (
    select
      array_agg(ord.id) as order_ids,
      array_agg(ord.order_number order by ord.order_number) as order_numbers,
      max(ord.invoice_number) as invoice_number, -- one per sitting (assign_invoice_number() reuses it)
      case when bool_or(ord.status <> 'completed') then 'open' else 'completed' end as order_status,
      min(ord.created_at) as order_created_at,
      sum(ord.total_amount) as order_total_amount,
      bool_and(ord.payment_details is not null) as payment_recorded
    from orders ord
    where ord.table_id = t.id
      and ord.status <> 'cancelled'
      and not (ord.status = 'completed' and ord.payment_details is not null)
  ) batch on batch.order_ids is not null
  where has_permission('dashboard.tables')
    and t.outlet_id = p.outlet_id
  order by t.table_number;
$$;

grant execute on function list_tables_for_outlet() to authenticated;


create or replace function create_table(p_table_number text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outlet_id uuid;
  v_new_id uuid;
begin
  select p.outlet_id into v_outlet_id
  from profiles p
  where p.user_id = auth.uid() and has_permission('tables.manage');

  if v_outlet_id is null then
    raise exception 'Not authorized to add tables';
  end if;

  insert into tables (table_number, outlet_id, state)
  values (p_table_number, v_outlet_id, 'open')
  returning id into v_new_id;

  return v_new_id;
end;
$$;

grant execute on function create_table(text) to authenticated;


-- ============================================================================
-- get_sales_by_order_type() / get_sales_by_type_bucketed(): order-type
-- statistics for the Sales Report page
-- ============================================================================
-- Same conventions as get_sales_report_uid: auth.uid() -> profiles.outlet_id
-- gate, status = 'completed' only (a sales report reflects closed
-- transactions, not open/cancelled ones), created_at in the caller's outlet timezone (my_timezone()) for
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
  where has_permission('reports.view')
    and p.outlet_id = o.outlet_id
    and o.status = 'completed'
    and (o.created_at at time zone (select my_timezone()))::date between p_from and p_to
  group by o.order_type
  order by o.order_type;
$$;

grant execute on function get_sales_by_order_type(date, date) to authenticated;


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
      (o.created_at at time zone (select my_timezone()))
    )::date as bucket_date,
    count(*) filter (where o.order_type = 'dine-in')::bigint as dine_in_count,
    count(*) filter (where o.order_type = 'pickup')::bigint as pickup_count,
    count(*) filter (where o.order_type = 'delivery')::bigint as delivery_count
  from orders o
  join profiles p on p.user_id = auth.uid()
  where has_permission('reports.view')
    and p.outlet_id = o.outlet_id
    and o.status = 'completed'
    and (o.created_at at time zone (select my_timezone()))::date between p_from and p_to
  group by 1
  order by 1;
$$;

grant execute on function get_sales_by_type_bucketed(date, date, text) to authenticated;


-- ============================================================================
-- INVOICE NUMBERING: admin-only status + manual reset
-- ============================================================================
-- The invoice number itself (format YYYY-MM-DD-NNNNN) is assigned entirely
-- by the assign_invoice_number() trigger on orders (db/schema.sql) — neither
-- RPC below ever writes orders.invoice_number. These two only expose the
-- running count (invoice_sequences, locked down with RLS + no policies —
-- see db/schema.sql) for the Settings page's "Invoicing" panel, admin-only
-- per the same "Not sure? go narrower" call as User Management.
--
-- Both resolve the outlet from the CALLER's own profile rather than taking
-- p_outlet_id from the client — an admin only ever manages their own
-- outlet's sequence, same trust boundary as every other admin RPC here.

-- ---------------------------------------------------------------------------
-- get_invoice_sequence_status(): current running count + last manual reset
-- for the caller's own outlet. Returns zero rows for a non-admin (or a
-- caller with no profile/outlet) rather than raising — the Settings page
-- just hides the panel when this comes back empty.
-- ---------------------------------------------------------------------------
create or replace function get_invoice_sequence_status()
returns table (
  outlet_id uuid,
  current_seq integer,
  last_reset_at timestamptz,
  reset_by_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.outlet_id,
    coalesce(s.current_seq, 0) as current_seq,
    s.last_reset_at,
    coalesce(rb.full_name, rb.email) as reset_by_name
  from profiles p
  left join invoice_sequences s on s.outlet_id = p.outlet_id
  left join profiles rb on rb.user_id = s.reset_by
  where p.user_id = auth.uid()
    and has_permission('invoicing.manage')
    and p.outlet_id is not null;
$$;

grant execute on function get_invoice_sequence_status() to authenticated;


-- ---------------------------------------------------------------------------
-- reset_invoice_sequence(): admin-only manual reset of the caller's own
-- outlet's running invoice sequence back to 0, so the next order gets
-- ...-00001. The YYYY-MM-DD date prefix keeps changing daily regardless —
-- this only resets the 5-digit running count, and only when an admin
-- explicitly asks for it. Nothing here tracks or enforces a cadence
-- (monthly/half-yearly/yearly) — that's the admin's own call each time.
-- ---------------------------------------------------------------------------
create or replace function reset_invoice_sequence()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outlet_id uuid;
begin
  select p.outlet_id into v_outlet_id
  from profiles p
  where p.user_id = auth.uid()
    and has_permission('invoicing.manage')
    and p.outlet_id is not null;

  if v_outlet_id is null then
    raise exception 'Not authorized to reset the invoice sequence';
  end if;

  insert into invoice_sequences (outlet_id, current_seq, last_reset_at, reset_by)
  values (v_outlet_id, 0, now(), auth.uid())
  on conflict (outlet_id) do update
    set current_seq = 0,
        last_reset_at = now(),
        reset_by = auth.uid();
end;
$$;

grant execute on function reset_invoice_sequence() to authenticated;


-- ============================================================================
-- TABLES MANAGEMENT no longer uses RPCs: the Tables page reads/writes the
-- `tables` rows directly, guarded by RLS (see db/schema.sql). Remove the
-- functions from an earlier version of this file if they were ever created.
-- ============================================================================
drop function if exists list_managed_tables(uuid);
drop function if exists save_table(uuid, uuid, text, text, integer, text);
drop function if exists delete_table(uuid, uuid);


-- ---------------------------------------------------------------------------
-- live_order_table_ids(): ids of this outlet's tables that currently carry a
-- live order (not cancelled, not yet paid). Lets the Tables page show
-- "occupied by an order" and lock the manual toggle for ANY signed-in role of
-- that outlet — including staff, who deliberately cannot read the orders table
-- itself. Returns table ids only, no order data.
-- ---------------------------------------------------------------------------
drop function if exists live_order_table_ids(uuid);

create or replace function live_order_table_ids(p_outlet_id uuid)
returns table (table_id uuid, live_orders integer)
language sql
stable
security definer
set search_path = public
as $$
  select o.table_id, count(*)::integer
  from orders o
  join profiles p
    on p.user_id = auth.uid()
   and p.outlet_id = p_outlet_id
   and has_permission('tables.view')
  where o.outlet_id = p_outlet_id
    and o.table_id is not null
    and o.status <> 'cancelled'
    and o.payment_details is null
  group by o.table_id;
$$;

grant execute on function live_order_table_ids(uuid) to authenticated;


-- ============================================================================
-- place_pickup_order(): New Order page, pickup orders
-- ============================================================================
-- Mirrors place_order() (same item JSON: menu_item_id, unit_price,
-- total_price, quantity) but creates a table-less pickup order with optional
-- customer details, a note and the container charge. place_order() itself is
-- untouched, so the Android path is unchanged.
-- Assumes orders(order_type, customer_name, customer_phone,
-- container_charge_amount, special_notes) — the columns the desktop app
-- already reads. If one differs this fails loudly at deploy/run time.
drop function if exists place_pickup_order(jsonb, numeric, numeric, numeric, numeric, text, text, text, uuid);
create or replace function place_pickup_order(
  p_items            jsonb,
  p_subtotal         numeric,
  p_tax              numeric,
  p_container_charge numeric,
  p_total            numeric,
  p_customer_name    text default null,
  p_customer_phone   text default null,
  p_notes            text default null,
  p_outlet_id        uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id    uuid;
  v_waiter_name text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'An order needs at least one item';
  end if;

  -- Must belong to the caller's own outlet and be an ordering role.
  if not exists (
    select 1 from profiles p
     where p.user_id = auth.uid()
       and p.outlet_id = p_outlet_id
       and has_permission('orders.place')
  ) then
    raise exception 'Not allowed to place orders for this outlet';
  end if;

  select first_name into v_waiter_name from profiles where user_id = auth.uid();

  insert into orders (
    table_id, order_type, status, waiter_id, waiter_name, outlet_id, order_number,
    customer_name, customer_phone, special_notes,
    subtotal_amount, tax_amount, container_charge_amount, total_amount, confirmed_at
  ) values (
    null, 'pickup', 'preparing', auth.uid(), v_waiter_name, p_outlet_id,
    get_next_order_number(p_outlet_id),
    nullif(btrim(p_customer_name), ''), nullif(btrim(p_customer_phone), ''), nullif(btrim(p_notes), ''),
    p_subtotal, p_tax, coalesce(p_container_charge, 0), p_total, now()
  )
  returning id into v_order_id;

  insert into order_items (order_id, menu_item_id, unit_price, total_price, quantity)
  select v_order_id,
         nullif(it->>'menu_item_id', '')::uuid,
         (it->>'unit_price')::numeric,
         (it->>'total_price')::numeric,
         (it->>'quantity')::int
  from jsonb_array_elements(p_items) as it;

  return v_order_id;
end;
$$;

grant execute on function place_pickup_order(jsonb, numeric, numeric, numeric, numeric, text, text, text, uuid) to authenticated;


-- ============================================================================
-- has_permission() / get_my_access(): database-driven roles and menus
-- ============================================================================
-- has_permission() is defined in db/schema.sql (RLS policies need it before this file runs).

-- get_my_access(): everything the UI needs in one call - the caller's role,
-- their permission codes and the menu entries they may see, in order.
create or replace function get_my_access()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
  v_perms jsonb;
  v_menus jsonb;
  v_org jsonb;
  v_groups jsonb;
begin
  select p.role into v_role
  from profiles p
  where p.user_id = auth.uid() and coalesce(p.is_active, true);

  if v_role is null then
    return jsonb_build_object('role', null, 'permissions', '[]'::jsonb, 'menus', '[]'::jsonb, 'org', null);
  end if;

  select coalesce(jsonb_agg(pm.code order by pm.code), '[]'::jsonb)
    into v_perms
  from permissions pm
  where has_permission(pm.code);   -- admin, or granted by one of the user's groups

  select coalesce(jsonb_agg(jsonb_build_object('code', m.code, 'label', m.label, 'icon', m.icon)
                            order by m.sort_order, m.code), '[]'::jsonb)
    into v_menus
  from app_menus m
  where m.is_active
    and (m.required_permission is null or has_permission(m.required_permission));

  select jsonb_build_object(
           'id', g.id, 'name', g.name, 'currency_code', g.currency_code, 'locale', g.locale,
           'timezone', my_timezone(), 'tax_label', g.tax_label)
    into v_org
  from profiles p join organizations g on g.id = p.org_id
  where p.user_id = auth.uid();

  select coalesce(jsonb_agg(g.name order by g.name), '[]'::jsonb)
    into v_groups
  from user_group_members m
  join user_groups g on g.id = m.group_id
  join profiles p on p.user_id = m.user_id and p.org_id = g.org_id
  where m.user_id = auth.uid();

  return jsonb_build_object('role', v_role, 'permissions', v_perms, 'menus', v_menus, 'org', v_org, 'groups', v_groups);
end;
$$;

grant execute on function get_my_access() to authenticated;


-- ============================================================================
-- Multi-tenant helpers used by the app
-- ============================================================================
-- assert_can_create_user(): called by the create-user path BEFORE any login is
-- created. Verifies the caller may manage users, the outlet belongs to the
-- caller's organization and the role is a known one. Returns the caller's
-- organization id so the profile is created inside it.
create or replace function assert_can_create_user(p_outlet_id uuid, p_role text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := current_org_id();
begin
  if not has_permission('users.manage') or v_org is null then
    raise exception 'Only admins can create users';
  end if;
  if p_role is null or p_role not in ('staff', 'manager', 'owner', 'admin', 'editor') then
    raise exception 'Unknown role';
  end if;
  if p_outlet_id is not null
     and not exists (select 1 from outlets o where o.id = p_outlet_id and o.org_id = v_org) then
    raise exception 'That outlet does not belong to your organization';
  end if;
  return v_org;
end;
$$;

grant execute on function assert_can_create_user(uuid, text) to authenticated;
