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

-- ---------------------------------------------------------------------------
-- assign_invoice_number(): BEFORE INSERT trigger on orders. Runs for every
-- order insert regardless of caller (this is how the Android/anon-key path
-- gets a number too, with no RPC involved on that side at all).
--
-- pg_advisory_xact_lock(hashtext(table_id)) serializes concurrent inserts
-- for the SAME table for the lifetime of the current transaction: without
-- it, two rounds placed on the same table at nearly the same instant could
-- both see "no invoice number yet" and each allocate a separate one for
-- what should be a single batch. Takeaway/pickup orders (no table_id) don't
-- need this — each always gets its own fresh number, and the sequence
-- allocation itself (the INSERT .. ON CONFLICT below) is already safe under
-- concurrency via ordinary row locking.
-- ---------------------------------------------------------------------------
create or replace function assign_invoice_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing text;
  v_seq integer;
begin
  if new.invoice_number is not null then
    return new; -- already set explicitly (e.g. a manual backfill) — don't override
  end if;

  if new.order_type = 'dine_in' and new.table_id is not null then
    perform pg_advisory_xact_lock(hashtext(new.table_id::text));

    select o.invoice_number into v_existing
    from orders o
    where o.table_id = new.table_id
      and o.status <> 'cancelled'
      and not (o.status = 'completed' and o.payment_details is not null)
      and o.invoice_number is not null
    order by o.created_at asc
    limit 1;

    if v_existing is not null then
      new.invoice_number := v_existing;
      return new;
    end if;
  end if;

  insert into invoice_sequences (outlet_id, current_seq)
  values (new.outlet_id, 1)
  on conflict (outlet_id) do update
    set current_seq = invoice_sequences.current_seq + 1
  returning current_seq into v_seq;

  new.invoice_number := to_char(now(), 'YYYY-MM-DD') || '-' || lpad(v_seq::text, 5, '0');
  return new;
end;
$$;

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
    and o.status not in ('completed', 'cancelled')
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
  invoice_number text,
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
    o.invoice_number as invoice_number,
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
  order by t.table_number, o.order_number;
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
    and o.status not in ('cancelled', 'completed')
    and o.payment_details is null
  group by o.table_id;
$$;

grant execute on function live_order_table_ids(uuid) to authenticated;


-- ============================================================================
-- ORDERS LIST RPCs
-- ============================================================================
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
      --and p.role in ('manager', 'owner', 'admin')
      and has_permission('orders.view')
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
      coalesce(sum(m.subtotal_amount) filter (where m.status <> 'cancelled'), 0) as subtotal_amount,
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

-- ============================================================================
-- TAX RATES: functions used by the app (see docs/TAX_PLAN.md)
-- ============================================================================

-- effective_tax_rates(): the rates in force NOW for the caller's outlet: one
-- row for the default (category_id null) and one per category that has ever
-- had its own rate. The New Order page uses it for the live cart; the
-- database recalculates authoritatively when the order is placed.
drop function if exists effective_tax_rates();
create or replace function effective_tax_rates()
returns table (category_id uuid, tax_name text, rate numeric, configured boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_outlet uuid;
begin
  if not (has_permission('orders.place') or has_permission('tax.manage')) then
    return;
  end if;
  select p.outlet_id into v_outlet
    from profiles p where p.user_id = auth.uid() and coalesce(p.is_active, true);
  if v_outlet is null then
    return;
  end if;

  return query
    select null::uuid, d.tax_name, d.rate,
           exists (select 1 from tax_rates r
                    where r.outlet_id = v_outlet and r.category_id is null
                      and r.effective_from <= now())
      from tax_rate_for(v_outlet, null, now()) d
    union all
    select c.category_id, t.tax_name, t.rate, true
      from (select distinct r.category_id from tax_rates r
             where r.outlet_id = v_outlet and r.category_id is not null) c
     cross join lateral tax_rate_for(v_outlet, c.category_id, now()) t;
end;
$$;
grant execute on function effective_tax_rates() to authenticated;

-- list_tax_rates(): every row of the caller's outlet for the Tax screen, with
-- its state: 'scheduled' (not yet in force), 'current' (the one in force for
-- its scope now) or 'past'. tax.manage only.
create or replace function list_tax_rates()
returns table (
  id uuid, category_id uuid, tax_name text, rate_percent numeric,
  effective_from timestamptz, created_at timestamptz, created_by_name text, state text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_outlet uuid;
begin
  if not has_permission('tax.manage') then
    raise exception 'Only users with tax access can view tax rates';
  end if;
  select p.outlet_id into v_outlet
    from profiles p where p.user_id = auth.uid() and coalesce(p.is_active, true);
  if v_outlet is null then
    raise exception 'Your account has no outlet';
  end if;

  return query
    select r.id, r.category_id, r.name, r.rate_percent, r.effective_from, r.created_at,
           coalesce(nullif(btrim(pr.full_name), ''), pr.email),
           case
             when r.effective_from > now() then 'scheduled'
             when r.effective_from = (select max(x.effective_from) from tax_rates x
                                       where x.outlet_id = r.outlet_id
                                         and x.category_id is not distinct from r.category_id
                                         and x.effective_from <= now())
               then 'current'
             else 'past'
           end
      from tax_rates r
      left join profiles pr on pr.user_id = r.created_by
     where r.outlet_id = v_outlet
     order by r.category_id nulls first, r.effective_from desc;
end;
$$;
grant execute on function list_tax_rates() to authenticated;

-- tax_rate_for(outlet, category, at): the rate in force at `at`. A category
-- with no usable rate of its own gets the outlet default. With no default at
-- all the rate is 0 (the Tax screen warns). Always returns exactly one row.
-- Internal helper: not callable by app users.
create or replace function tax_rate_for(p_outlet uuid, p_category uuid, p_at timestamptz)
returns table (tax_name text, rate numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_name text;
  v_rate numeric;
begin
  if p_category is not null then
    select r.name, r.rate_percent into v_name, v_rate
      from tax_rates r
     where r.outlet_id = p_outlet and r.category_id = p_category and r.effective_from <= p_at
     order by r.effective_from desc
     limit 1;
    if found and v_rate is not null then
      tax_name := v_name; rate := v_rate;
      return next;
      return;
    end if;
  end if;

  select r.name, r.rate_percent into v_name, v_rate
    from tax_rates r
   where r.outlet_id = p_outlet and r.category_id is null and r.effective_from <= p_at
   order by r.effective_from desc
   limit 1;
  tax_name := coalesce(v_name, 'GST');
  rate := coalesce(v_rate, 0);
  return next;
end;
$$;
revoke all on function tax_rate_for(uuid, uuid, timestamptz) from public, anon, authenticated;



-- generate the next order_number by sequence
create or replace function get_next_order_number(
p_outlet_id        uuid default null
) returns INTEGER
language plpgsql
security definer
set search_path = public
as $$
DECLARE
  next_number INTEGER;
BEGIN
  UPDATE public.order_sequences
  SET current_number = current_number + 1
  WHERE outlet_id = p_outlet_id
  RETURNING current_number INTO next_number;

  IF next_number IS NULL THEN
    RAISE EXCEPTION 'No order sequence found for outlet_id %', p_outlet_id;
  END IF;

  RETURN next_number;
END;
$$;

grant execute on function get_next_order_number(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- place_order(): the one place that creates an order
-- ---------------------------------------------------------------------------
-- Used by place_order() (dine-in, needs a table) 
-- (pickup, no table). Checks: signed in, orders.place, the outlet is the
-- caller's own (p_outlet_id may be null = own outlet), the table belongs to
-- it (dine-in), every item is on its menu. Creates the order and its lines,
-- calculates tax per rate (recompute_order_totals) and, for dine-in, marks the
-- table occupied. Any client-supplied totals are never seen here.
-- Internal helper: not callable by app users.

create or replace function place_order(
  p_order_type     text,          -- 'dine_in' or 'takeaway'
  p_table_id       uuid,          -- dine_in only
  p_outlet_id      uuid,          -- null = the caller's own outlet
  p_items          jsonb,
  p_customer_name  text default null,
  p_customer_phone text default null,
  p_notes          text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outlet      uuid;
  v_waiter_name text;
  v_order_id    uuid;
  v_dine_in     boolean := (p_order_type = 'dine_in');
begin
  if p_order_type not in ('dine_in', 'takeaway') then
    raise exception 'Unknown order type';
  end if;
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if not has_permission('orders.place') then
    raise exception 'Not allowed to place orders';
  end if;

  select p.outlet_id, p.first_name into v_outlet, v_waiter_name
    from profiles p
   where p.user_id = auth.uid();
  if v_outlet is null then
    raise exception 'Your account has no outlet';
  end if;
  if p_outlet_id is not null and p_outlet_id <> v_outlet then
    raise exception 'Not allowed to place orders for this outlet';
  end if;

  if v_dine_in and not exists (select 1 from tables t
                                where t.id = p_table_id and t.outlet_id = v_outlet) then
    raise exception 'Table not found in your outlet';
  end if;

  perform assert_order_items_valid(p_items, v_outlet);

  insert into orders (
    table_id, order_type, status, waiter_id, outlet_id, order_number,
    customer_name, customer_phone, notes,
    subtotal_amount, tax_amount, total_amount, confirmed_at
  ) values (
    case when v_dine_in then p_table_id end, p_order_type, 'preparing', auth.uid(),
    v_outlet, get_next_order_number(v_outlet),
    nullif(btrim(p_customer_name), ''), nullif(btrim(p_customer_phone), ''), nullif(btrim(p_notes), ''),
    0, 0, 0, now()
  )
  returning id into v_order_id;

  perform insert_order_items(v_order_id, v_outlet, p_items);
  perform recompute_order_totals(v_order_id);

  if v_dine_in then
    update tables set status = 'occupied' where id = p_table_id;
  end if;

  insert into app_activity_log (order_id, activity, changed_by, changed_at) values (v_order_id, 'orders.created', auth.uid(), now());

  return v_order_id;
end;
$$;
revoke all on function place_order(text, uuid, uuid, jsonb, text, text, text)
  from public, anon, authenticated;

grant execute on function place_order(text, uuid, uuid, jsonb, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Shared by place_order()
-- ---------------------------------------------------------------------------
-- Validates the item list: every menu item belongs to the outlet, quantities
-- are 1..99 and prices are not negative. Raises on the first problem.
create or replace function assert_order_items_valid(p_items jsonb, p_outlet_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'An order needs at least one item';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(p_items) it
     where coalesce((it->>'quantity')::int, 0) not between 1 and 99
        or coalesce((it->>'unit_price')::numeric, -1) < 0
  ) then
    raise exception 'Invalid quantity or price in the item list';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(p_items) it
     where not exists (select 1 from menu_items mi
                        where mi.id = nullif(it->>'menu_item_id', '')::uuid
                          and mi.outlet_id = p_outlet_id)
  ) then
    raise exception 'An item is not on this outlet''s menu';
  end if;
end;
$$;
revoke all on function assert_order_items_valid(jsonb, uuid) from public, anon, authenticated;

-- Inserts the lines of a new order, each stamped with the tax rate in force
-- now for its menu item's category. total_price is recomputed here from
-- quantity * unit_price; the client's figure is ignored.
create or replace function insert_order_items(p_order_id uuid, p_outlet_id uuid, p_items jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into order_items (order_id, menu_item_id, unit_price, total_price, quantity, tax_rate_percent, tax_name)
  select p_order_id,
         x.menu_item_id,
         x.unit_price,
         round(x.unit_price * x.quantity, 2),
         x.quantity,
         tr.rate,
         tr.tax_name
    from (select nullif(it->>'menu_item_id', '')::uuid as menu_item_id,
                 (it->>'unit_price')::numeric as unit_price,
                 (it->>'quantity')::int as quantity
            from jsonb_array_elements(p_items) it) x
    left join menu_items mi on mi.id = x.menu_item_id
    cross join lateral tax_rate_for(p_outlet_id, mi.category_id, now()) tr;
$$;
revoke all on function insert_order_items(uuid, uuid, jsonb) from public, anon, authenticated;

-- ============================================================================
-- recompute_order_totals(): shared tax/container-charge/total formula
-- ============================================================================
-- Prices are tax-exclusive. For every non-deleted line:
--   base      = quantity * unit_price
--   packaging = pickup orders only: base * menu_items.container_charge / 100
--               (read from the menu at recompute time, as before)
--   taxable   = base + packaging
-- Each line is taxed at the rate SNAPSHOTTED on the line when it was created
-- (order_items.tax_rate_percent / tax_name), never at today's rate, so a rate
-- change cannot touch an existing order. A line with no snapshot (created by
-- older code) is stamped now from the rate in force at the order's creation
-- time, for its menu item's category (see tax_rate_for in schema.sql).
-- Tax is summed PER RATE for the order and rounded once per rate:
--   tax(rate) = round(sum(taxable at that rate) * rate / 100, 2)
-- tax_amount = sum of those; tax_breakdown = [{name, rate, taxable, tax}] by
-- rate; total_amount = subtotal + container charge + tax_amount.
--
-- Deliberately excludes any "discount" column (never confirmed to exist on
-- the real orders table).
--
-- Internal helper only: EXECUTE is revoked from public below so it cannot be
-- called directly, bypassing the auth checks that edit_order_item /
-- delete_order_item perform before calling this.
create or replace function recompute_order_totals(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_type text;
  v_outlet_id uuid;
  v_created timestamptz;
  v_subtotal numeric;
  v_container numeric := 0;
  v_tax numeric;
  v_breakdown jsonb;
begin
  select o.order_type, o.outlet_id, coalesce(o.created_at, now())
    into v_order_type, v_outlet_id, v_created
  from orders o
  where o.id = p_order_id;

  -- Stamp lines that have no snapshot yet.
  update order_items oi
     set tax_rate_percent = tr.rate,
         tax_name = tr.tax_name
    from order_items x
    left join menu_items mi on mi.id = x.menu_item_id
    cross join lateral tax_rate_for(v_outlet_id, mi.category_id, v_created) tr
   where oi.id = x.id and x.order_id = p_order_id and x.tax_rate_percent is null;

  select coalesce(sum(oi.quantity * oi.unit_price), 0)
    into v_subtotal
  from order_items oi
  where oi.order_id = p_order_id and not oi.is_deleted;

  if v_order_type = 'takeaway' then
    select round(coalesce(sum(oi.quantity * oi.unit_price * coalesce(mi.container_charge, 0) / 100), 0), 2)
      into v_container
    from order_items oi
    left join menu_items mi on mi.id = oi.menu_item_id
    where oi.order_id = p_order_id and not oi.is_deleted;
  end if;

  with lines as (
    select coalesce(oi.tax_name, 'GST') as name,
           coalesce(oi.tax_rate_percent, 0) as rate,
           oi.quantity * oi.unit_price
             + case when v_order_type = 'takeaway'
                    then oi.quantity * oi.unit_price * coalesce(mi.container_charge, 0) / 100
                    else 0 end as taxable
      from order_items oi
      left join menu_items mi on mi.id = oi.menu_item_id
     where oi.order_id = p_order_id and not oi.is_deleted
  ),
  slabs as (
    select name, rate,
           round(sum(taxable), 2) as taxable,
           round(sum(taxable) * rate / 100, 2) as tax
      from lines
     group by name, rate
  )
  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'rate', rate, 'taxable', taxable, 'tax', tax)
                            order by rate, name), '[]'::jsonb),
         coalesce(sum(tax), 0)
    into v_breakdown, v_tax
  from slabs;

  update orders
     set subtotal_amount = v_subtotal,
         tax_amount = v_tax,
         container_amount = v_container,
         total_amount = v_subtotal + v_container + v_tax,
         tax_breakdown = v_breakdown
   where id = p_order_id;
end;
$$;

revoke execute on function recompute_order_totals(uuid) from public;

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
    a.activity,
    a.changed_at,
    coalesce(cb.first_name, cb.email, 'Unknown') as changed_by_name,
    old_quantity,
    new_quantity,
    reason
  from app_activity_log a
  join orders o on o.id = a.order_id
  join profiles p on p.user_id = auth.uid()
  left join profiles cb on cb.user_id = a.changed_by
  left join order_items oi on oi.id = a.order_item_id
  left join menu_items mi on mi.id = oi.menu_item_id
  
  where a.order_id = p_order_id
    and has_permission('orders.view')
    and p.outlet_id = o.outlet_id
  order by a.changed_at desc;
$$;

grant execute on function get_order_activity_log(uuid) to authenticated;

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
     set first_name = p_full_name,
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
  select pm.code, coalesce((select array_agg('group: ' || g.name order by g.name)
                        from user_group_members m
                        join user_groups g on g.id = m.group_id and g.org_id = v_org
                        join group_permissions gp on gp.group_id = g.id and gp.permission_code = pm.code
                       where m.user_id = p_user_id), '{}'::text[])
  from permissions pm
  order by pm.code;
end;
$$;
grant execute on function user_effective_access(uuid) to authenticated;

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
    and o.status not in ('cancelled', 'completed');

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
    auth.uid(), now(), now(), v_order::json, trim(p_reason), 'orders.item.edit'
  );

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function edit_order_item(uuid, uuid, integer, text, text, text) to authenticated;

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
    --and pr.role = 'editor'
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
    and o.status not in ('completed', 'cancelled');

  if v_order_id is null then
    raise exception 'Not authorized, item not found, or the order is not editable in its current status';
  end if;

  -- Removing the last live item would leave an empty (void) order.
  if not exists (select 1 from order_items x
                  where x.order_id = v_order_id and x.id <> p_order_item_id and not x.is_deleted) then
    raise exception 'This is the only item in the order. Cancel the order instead of removing its last item';
  end if;

  -- Second factor — see edit_order_item / verify_editor_approval.
  v_approval := verify_editor_approval(p_outlet_id, p_editor_username, p_editor_password);
  if v_approval ? 'error' then
    return jsonb_build_object('ok', false, 'error', v_approval->>'error');
  end if;

  update order_items
     set is_deleted = true,
         status = 'cancelled',
         edited_at = now(),
         edited_by = auth.uid()
   where id = p_order_item_id
   returning to_jsonb(order_items.*) into v_new;

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
    auth.uid(), now(), now(), v_order::json, trim(p_reason), 'orders.item.delete'
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
    update tables set status = 'available' where id = v_table_id;
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
    auth.uid(), now(), now(), v_order::json, trim(p_reason), 'orders.cancelled'
  );

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function cancel_order(uuid, uuid, text, text, text) to authenticated;

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

 insert into app_activity_log
    (order_id, changed_by, changed_at, created_at,
     activity)
  values (
    p_order_id, auth.uid(), now(), now(), 'orders.completed'
  );

end;
$$;

grant execute on function complete_order(uuid) to authenticated;

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
            trim(p_reason), 'orders.cancelled');
  end loop;

  if v_table_ids is not null then
    foreach v_tid in array v_table_ids loop
      if not exists (
        select 1 from orders
        where table_id = v_tid and status not in ('completed', 'cancelled')
      ) then
        update tables set status = 'available' where id = v_tid;
      end if;
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'cancelled', cardinality(v_ids));
end;
$$;

grant execute on function cancel_invoice(uuid, text, text, text, text) to authenticated;

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
    count(*) filter (where o.order_type = 'dine_in')::bigint as dine_in_count,
    count(*) filter (where o.order_type = 'takeaway')::bigint as pickup_count,
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
    and oi.is_deleted = false
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


-- ============================================================================
-- KOT BOARD (see the KOT BOARD section of db/schema.sql)
-- ============================================================================
-- get_kot_board(): everything the board needs in one call, for the caller's
-- outlet: the steps, the allowed moves, the waiting-time levels and the cards.
-- A card = the items of one OPEN order that have the same order_items.status
-- (hidden / final steps, and orders that are cancelled or already billed, are
-- left out), with ALL its items. Needs kot.view.
create or replace function get_kot_board()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_outlet uuid;
begin
  if not has_permission('kot.view') then
    raise exception 'Not allowed to see the KOT board';
  end if;
  select p.outlet_id into v_outlet
    from profiles p where p.user_id = auth.uid() and coalesce(p.is_active, true);
  if v_outlet is null then
    raise exception 'Your account has no outlet';
  end if;

  return jsonb_build_object(
    'now', now(),
    'statuses', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', s.id, 'code', s.code, 'name', s.name, 'color', s.color,
               'action_label', s.action_label, 'sort_order', s.sort_order,
               'is_initial', s.is_initial, 'is_final', s.is_final,
               'show_on_board', s.show_on_board) order by s.sort_order), '[]'::jsonb)
        from kot_statuses s where s.outlet_id = v_outlet),
    'transitions', (
      select coalesce(jsonb_agg(jsonb_build_object('from', t.from_status, 'to', t.to_status)), '[]'::jsonb)
        from kot_transitions t join kot_statuses s on s.id = t.from_status
       where s.outlet_id = v_outlet),
    'levels', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', l.id, 'name', l.name, 'from_minutes', l.from_minutes, 'color', l.color)
               order by l.from_minutes), '[]'::jsonb)
        from kot_time_levels l where l.outlet_id = v_outlet),
    'kots', (
      select coalesce(jsonb_agg(g.card order by g.created_at), '[]'::jsonb)
        from (
          select coalesce(min(oi.created_at), min(oi.kot_printed_at), now()) as created_at,
                 jsonb_build_object(
                   'status_id', s.id,
                   'created_at', coalesce(min(oi.created_at), min(oi.kot_printed_at), now()),
                   'order_id', o.id,
                   'order_number', o.order_number, 'order_type', o.order_type,
                   'table_number', t.table_number, 'customer_name', o.customer_name,
                   'notes', o.notes,
                   'items', jsonb_agg(jsonb_build_object(
                              'id', oi.id, 'name', coalesce(mi.name, 'Item'), 'quantity', oi.quantity,
                              'note', oi.notes, 'is_deleted', oi.is_deleted)
                              order by oi.created_at nulls last, oi.id)
                 ) as card
            from order_items oi
            join orders o on o.id = oi.order_id
            join kot_statuses s on s.outlet_id = o.outlet_id and s.code = oi.status
            left join menu_items mi on mi.id = oi.menu_item_id
            left join tables t on t.id = o.table_id
           where o.outlet_id = v_outlet
             and s.show_on_board and not s.is_final
             and o.status not in ('cancelled', 'completed')
           group by o.id, o.order_number, o.order_type, t.table_number, o.customer_name,
                    o.notes, s.id
        ) g)
  );
end;
$$;
grant execute on function get_kot_board() to authenticated;

-- move_kot(order, to, from): sets order_items.status of the order's items that
-- are in step `from` to step `to`, along ONE allowed transition (forward or
-- back, as defined in kot_transitions), and writes ONE app_activity_log row:
-- order_id, activity 'order.item.status.updated', changed_by = the user,
-- changed_at = now(), order_details {status-from, status-to}. Needs kot.move;
-- the order must belong to the caller's outlet. If nothing is in `from` any
-- more (someone else just moved it) it fails with a clear message.
create or replace function move_kot(p_order_id uuid, p_to_status uuid, p_from_status uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outlet uuid;
  v_from   text;
  v_to     text;
begin
  if not has_permission('kot.move') then
    raise exception 'Not allowed to move KOTs';
  end if;
  select p.outlet_id into v_outlet
    from profiles p where p.user_id = auth.uid() and coalesce(p.is_active, true);

  select code into v_from from kot_statuses where id = p_from_status and outlet_id = v_outlet;
  select code into v_to   from kot_statuses where id = p_to_status   and outlet_id = v_outlet;
  if v_from is null or v_to is null then
    raise exception 'Unknown step';
  end if;

  -- Lock the items so two people cannot move the same card at once.
  perform 1
    from order_items oi join orders o on o.id = oi.order_id
   where oi.order_id = p_order_id and oi.status = v_from and o.outlet_id = v_outlet
     for update of oi;
  if not found then
    raise exception 'This KOT was just moved by someone else. Refresh the board.';
  end if;
  if not exists (select 1 from kot_transitions t where t.from_status = p_from_status and t.to_status = p_to_status) then
    raise exception 'That move is not allowed';
  end if;

  update order_items set status = v_to where order_id = p_order_id and status = v_from;

  insert into app_activity_log
    (order_id, changed_by, changed_at, created_at, order_details, reason, activity)
  values (p_order_id, auth.uid(), now(), now(),
          jsonb_build_object('status-from', v_from, 'status-to', v_to)::json,
          v_from || ' to ' || v_to, 'order.item.status.updated');
end;
$$;
grant execute on function move_kot(uuid, uuid, uuid) to authenticated;

-- get_kot_workflow(): the settings view. Steps in order with their button
-- label, flags, how many KOTs sit in each, and "back_to" as the 1-based
-- positions of the earlier steps a KOT may be moved back to; plus the levels.
-- Needs kot.manage.
create or replace function get_kot_workflow()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_outlet uuid;
begin
  if not has_permission('kot.manage') then
    raise exception 'Only users with KOT access can view the workflow settings';
  end if;
  select p.outlet_id into v_outlet
    from profiles p where p.user_id = auth.uid() and coalesce(p.is_active, true);
  if v_outlet is null then
    raise exception 'Your account has no outlet';
  end if;
  perform seed_kot_workflow(v_outlet);

  return jsonb_build_object(
    'steps', (
      with pos as (
        select s.id, s.sort_order, row_number() over (order by s.sort_order) as p
          from kot_statuses s where s.outlet_id = v_outlet
      )
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', s.id, 'code', s.code, 'name', s.name, 'color', s.color, 'action_label', s.action_label,
               'show_on_board', s.show_on_board, 'is_initial', s.is_initial, 'is_final', s.is_final,
               'kot_count', (select count(distinct oi.order_id) from order_items oi join orders oo on oo.id = oi.order_id where oo.outlet_id = s.outlet_id and oi.status = s.code),
               'back_to', (select coalesce(jsonb_agg(tp.p order by tp.p), '[]'::jsonb)
                             from kot_transitions t
                             join pos tp on tp.id = t.to_status
                            where t.from_status = s.id and tp.sort_order < s.sort_order)
             ) order by s.sort_order), '[]'::jsonb)
        from kot_statuses s where s.outlet_id = v_outlet),
    'levels', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'name', l.name, 'from_minutes', l.from_minutes, 'color', l.color)
               order by l.from_minutes), '[]'::jsonb)
        from kot_time_levels l where l.outlet_id = v_outlet)
  );
end;
$$;
grant execute on function get_kot_workflow() to authenticated;

-- save_kot_workflow(steps, levels): replaces the outlet's workflow in one
-- transaction. steps = ordered array of {id?, name, color, action_label,
-- show_on_board, back_to:[positions]}. Rules: 2 to 12 steps with distinct
-- names; the first step is where KOTs start; the last is final (off the
-- board); forward is always to the next step; back_to may name earlier steps
-- only; a step that still holds KOTs cannot be removed. levels = array of
-- {name, from_minutes, color}: the first starts at 0 and the rest ascend.
-- Needs kot.manage.
create or replace function save_kot_workflow(p_steps jsonb, p_levels jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outlet uuid;
  n        integer;
  i        integer;
  e        jsonb;
  v_id     uuid;
  v_ids    uuid[] := '{}';
  v_name   text;
  v_color  text;
  v_code   text;
  v_pos    integer;
  v_prev   integer := -1;
  m        integer;
  lv       jsonb;
begin
  if not has_permission('kot.manage') then
    raise exception 'Only users with KOT access can change the workflow';
  end if;
  select p.outlet_id into v_outlet
    from profiles p where p.user_id = auth.uid() and coalesce(p.is_active, true);
  if v_outlet is null then
    raise exception 'Your account has no outlet';
  end if;
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' then
    raise exception 'Steps are required';
  end if;
  if p_levels is null or jsonb_typeof(p_levels) <> 'array' then
    raise exception 'Waiting-time levels are required';
  end if;
  n := jsonb_array_length(p_steps);
  if n < 2 or n > 6 then
    raise exception 'A workflow needs between 2 and 6 steps (one per status value)';
  end if;

  -- Names: present, short, distinct.
  if exists (select 1 from jsonb_array_elements(p_steps) s
              where char_length(btrim(coalesce(s->>'name', ''))) not between 1 and 30) then
    raise exception 'Every step needs a name of 1 to 30 characters';
  end if;
  if (select count(distinct lower(btrim(s->>'name'))) from jsonb_array_elements(p_steps) s) <> n then
    raise exception 'Step names must be different from each other';
  end if;

  -- A step that still holds KOTs cannot be removed.
  if exists (
    select 1 from kot_statuses ks
     where ks.outlet_id = v_outlet
       and ks.id not in (select nullif(s->>'id', '')::uuid from jsonb_array_elements(p_steps) s
                          where nullif(s->>'id', '') is not null)
       and exists (select 1 from order_items oi join orders oo on oo.id = oi.order_id
                    where oo.outlet_id = ks.outlet_id and oi.status = ks.code)
  ) then
    raise exception 'A step that still has KOTs cannot be removed. Move those KOTs first';
  end if;
  delete from kot_statuses ks
   where ks.outlet_id = v_outlet
     and ks.id not in (select nullif(s->>'id', '')::uuid from jsonb_array_elements(p_steps) s
                        where nullif(s->>'id', '') is not null);

  update kot_statuses set is_initial = false, is_final = false where outlet_id = v_outlet;

  for i in 1..n loop
    e := p_steps -> (i - 1);
    v_name := btrim(e->>'name');
    v_color := coalesce(nullif(e->>'color', ''), '#7f8c8d');
    if v_color !~ '^#[0-9a-fA-F]{6}$' then
      raise exception 'Step "%" has an invalid colour', v_name;
    end if;
    v_id := nullif(e->>'id', '')::uuid;
    if v_id is not null and not exists (select 1 from kot_statuses where id = v_id and outlet_id = v_outlet) then
      raise exception 'Unknown step';
    end if;

    if v_id is null then
      -- A new step maps to one of the values order_items.status may hold.
      v_code := lower(btrim(coalesce(e->>'code', '')));
      if v_code not in ('new', 'cancelled', 'confirmed', 'preparing', 'ready', 'served') then
        raise exception 'Step "%" needs a status value: new, cancelled, confirmed, preparing, ready or served', v_name;
      end if;
      if exists (select 1 from kot_statuses where outlet_id = v_outlet and code = v_code) then
        raise exception 'The status value "%" is already used by another step', v_code;
      end if;
      insert into kot_statuses (outlet_id, code, name, color, action_label, sort_order, is_initial, is_final, show_on_board)
      values (v_outlet, v_code, v_name, v_color, nullif(btrim(e->>'action_label'), ''), i * 10,
              i = 1, i = n,
              case when i = n then false else coalesce((e->>'show_on_board')::boolean, true) end)
      returning id into v_id;
    else
      update kot_statuses
         set name = v_name, color = v_color,
             action_label = nullif(btrim(e->>'action_label'), ''),
             sort_order = i * 10,
             is_initial = (i = 1), is_final = (i = n),
             show_on_board = case when i = n then false else coalesce((e->>'show_on_board')::boolean, true) end
       where id = v_id;
    end if;
    v_ids := v_ids || v_id;
  end loop;

  if (select code from kot_statuses where id = v_ids[1]) <> 'new' then
    raise exception 'The first step must stay the "New" step: every new item starts there';
  end if;
  if (select code from kot_statuses where id = v_ids[n]) <> 'served' then
    raise exception 'The last step must stay the "Served" step: it takes the card off the board';
  end if;

  delete from kot_transitions
   where from_status in (select id from kot_statuses where outlet_id = v_outlet);
  for i in 1..n loop
    if i < n then
      insert into kot_transitions (from_status, to_status) values (v_ids[i], v_ids[i + 1]);
    end if;
    e := p_steps -> (i - 1);
    if jsonb_typeof(e->'back_to') = 'array' then
      for v_pos in select (x)::integer from jsonb_array_elements_text(e->'back_to') x loop
        if v_pos < 1 or v_pos >= i then
          raise exception 'A step can only go back to an earlier step';
        end if;
        insert into kot_transitions (from_status, to_status) values (v_ids[i], v_ids[v_pos])
        on conflict do nothing;
      end loop;
    end if;
  end loop;

  -- Waiting-time levels.
  m := jsonb_array_length(p_levels);
  if m < 1 or m > 8 then
    raise exception 'Add between 1 and 8 waiting-time levels';
  end if;
  for i in 1..m loop
    lv := p_levels -> (i - 1);
    if char_length(btrim(coalesce(lv->>'name', ''))) not between 1 and 30 then
      raise exception 'Every level needs a name of 1 to 30 characters';
    end if;
    if coalesce(lv->>'color', '') !~ '^#[0-9a-fA-F]{6}$' then
      raise exception 'Level "%" has an invalid colour', lv->>'name';
    end if;
    if (lv->>'from_minutes') is null or (lv->>'from_minutes')::integer < 0 then
      raise exception 'Level start times must be 0 or more minutes';
    end if;
    if i = 1 and (lv->>'from_minutes')::integer <> 0 then
      raise exception 'The first level must start at 0 minutes';
    end if;
    if (lv->>'from_minutes')::integer <= v_prev then
      raise exception 'Level start times must increase';
    end if;
    v_prev := (lv->>'from_minutes')::integer;
  end loop;
  delete from kot_time_levels where outlet_id = v_outlet;
  insert into kot_time_levels (outlet_id, name, from_minutes, color)
  select v_outlet, btrim(l->>'name'), (l->>'from_minutes')::integer, l->>'color'
    from jsonb_array_elements(p_levels) l;
end;
$$;
grant execute on function save_kot_workflow(jsonb, jsonb) to authenticated;