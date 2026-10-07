-- 1. Create a function that inserts a new row into public.profiles
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (user_id, first_name, last_name, email, user_role, is_active)
  values (new.id, '', '', new.email, 'staff', TRUE)
  ON CONFLICT (user_id) DO NOTHING;
  return new;
end;
$$;

-- 2. Create the trigger that runs after a user is inserted into auth.users
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- 1. Create a reusable function that sets updated_at to now()
create or replace function update_updated_at_column()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

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

-- has_permission(code): access comes ONLY from groups. True for an active
-- caller who is an admin (always, so an organization can never lock itself
-- out) or a member of a group of THEIR OWN organization that grants the code.
-- The role no longer grants anything by itself; role_permissions is kept only
-- as the template the default groups are seeded from (see below).
-- (Replaces the definition earlier in this file; everything that calls
-- has_permission, including every RLS policy, picks this up automatically.)
create or replace function has_permission(p_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from profiles p
    where p.user_id = auth.uid()
      and coalesce(p.is_active, true)
      and (
        --p.role = 'admin'
        --or 
        exists (select 1
                     from user_group_members m
                     join user_groups g       on g.id = m.group_id
                     join group_permissions gp on gp.group_id = g.id
                    where m.user_id = p.user_id
                      and g.org_id = p.org_id
                      and gp.permission_code = p_code)
      )
  );
$$;

grant execute on function has_permission(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Helpers (stable + security definer so RLS and functions can use them)
-- ---------------------------------------------------------------------------
create or replace function current_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.org_id from profiles p
   where p.user_id = auth.uid() and coalesce(p.is_active, true);
$$;

-- IANA timezone of an outlet: its own override, else its organization's.
create or replace function outlet_timezone(p_outlet_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select coalesce(o.timezone, g.timezone)
       from outlets o join organizations g on g.id = o.org_id
      where o.id = p_outlet_id),
    'Asia/Kolkata');
$$;

-- Timezone of the CALLER's outlet. Takes no arguments, so a report query can
-- write `at time zone (select my_timezone())` and Postgres evaluates it once
-- per query instead of once per row.
create or replace function my_timezone()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select outlet_timezone((select p.outlet_id from profiles p where p.user_id = auth.uid()));
$$;

grant execute on function current_org_id(), is_platform_admin(), outlet_timezone(uuid), my_timezone() to authenticated;

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
-- list_tables_for_outlet() / create_table(): backs the Dashboard table-cards
-- view (src/renderer/pages/Dashboard.tsx)
-- ============================================================================

create or replace function list_tables_for_outlet()
returns table (
  table_id uuid,
  table_number text,
  table_state text,
  order_id uuid,
  order_status text,
  order_created_at timestamptz,
  order_total_amount numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    t.id as table_id,
    t.table_number::text as table_number,
    t.status as table_state,
    o.id as order_id,
    o.status as order_status,
    o.created_at as order_created_at,
    o.total_amount as order_total_amount
  from tables t
  join profiles p on p.user_id = auth.uid()
  -- Most recent order per table, any status — this is what actually
  -- distinguishes "active" (yellow) from "just paid" (green) from "no
  -- recent order" (empty/available). tables.state alone can't do this: it
  -- flips back to 'open' (free) the MOMENT an order settles, so a purely
  -- state-based query couldn't tell "just paid, still worth showing a
  -- reprint option" apart from "been empty for hours."
  left join lateral (
    select ord.*
    from orders ord
    where ord.table_id = t.id
    order by ord.created_at desc
    limit 1
  ) o on true
  where
   --p.role in ('manager', 'owner', 'admin')
   has_permission('tables.view')
    and t.outlet_id = p.outlet_id
  order by t.table_number;
$$;

grant execute on function list_tables_for_outlet() to authenticated;

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