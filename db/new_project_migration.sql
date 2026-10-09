-- ============================================================================
-- DIRECT-QUERY ITEM EDIT/DELETE: RLS for order_items / order_item_audit / orders
-- ============================================================================
-- editOrderItem()/deleteOrderItem() (src/main/ordersListManager.ts) now do a
-- pre-flight read as plain .from('order_items')/.from('orders') SELECTs
-- (easier to see and debug — the network tab and Supabase logs show the
-- actual table/filter, not an opaque rpc() call) before calling
-- edit_order_item()/delete_order_item() to do the actual write. Those two
-- RPCs are still `security definer` and still fully re-check "caller is
-- manager/owner/admin of the item's outlet, and the order is still open"
-- themselves, same as always — the write side of this was deliberately kept
-- as one atomic RPC call rather than split into several client requests, so
-- it doesn't rely on RLS for its authorization or its atomicity.
--
-- What DOES rely on RLS is the pre-flight read above: without a policy,
-- either every authenticated-but-unprivileged account could read any item/
-- order (RLS off), or none of them could (RLS on, no policy) — including the
-- manager/owner/admin accounts that should be able to. The SELECT policies
-- below reproduce the RPCs' own role/outlet rule for that read. The UPDATE/
-- INSERT policies on these tables are not currently exercised by the app
-- (the RPC path bypasses RLS as security definer) — they're left in as
-- defense-in-depth in case a future direct write is ever added here.
--
-- IMPORTANT: the Android-facing print/settle path (src/main/supabaseClient.ts,
-- via getClient() / the ANON key, no user session) ALSO queries orders/
-- order_items/tables directly and must keep working exactly as before —
-- turning RLS on for a table blocks every role that has no matching policy,
-- so each table below gets an explicit "anon: unrestricted" policy that
-- reproduces today's no-RLS behavior for anon, alongside the new restricted
-- policy for `authenticated`. Only the new authenticated-role direct-query
-- code path is actually constrained by this.
--
-- Every RPC elsewhere in db/functions.sql (list_orders, get_order_detail,
-- complete_order, save_order_payment, etc.) is `security definer`, so it
-- keeps running with the function owner's privileges and is unaffected by
-- RLS being turned on here — nothing else needs to change for those to keep
-- working.
--
-- Uses profiles.user_id (not profiles.id) to match auth.uid() — this file's
-- already-confirmed real join, per every RPC above and the note near
-- get_sales_report_uid().
-- Permission tables and has_permission() come first: every policy below uses it.
-- ============================================================================
-- ROLE PERMISSIONS + NAVIGATION MENU (database-driven access)
-- ============================================================================
-- permissions       : the things a user can be allowed to do
-- role_permissions  : which role has which permission  (role = profiles.role)
-- app_menus         : sidebar entries; each requires one permission (or none)
--
-- The seed below reproduces today's hardcoded rules exactly. The 'editor'
-- role gets NO permissions on purpose: editors only approve edits/deletes/
-- cancels (verify_editor_approval checks role = 'editor' directly and does
-- not use this table). 'admin' always passes has_permission() (see
-- db/functions.sql), so a bad edit here can never lock every admin out.
-- Configuration is changed with SQL for now; there is deliberately no write
-- policy, so the app itself cannot change who can do what.
create table if not exists permissions (
  code        text primary key,
  description text not null default ''
);

alter table permissions      enable row level security;

drop policy if exists "authenticated read permissions" on permissions;
create policy "authenticated read permissions" on permissions for select to authenticated using (true);


create table if not exists app_menus (
  code                text primary key,          -- the route id the app knows about
  label               text not null,
  icon                text not null default 'info',
  sort_order          integer not null default 0,
  required_permission text references permissions(code) on delete set null,
  is_active           boolean not null default true
);

alter table app_menus        enable row level security;

drop policy if exists "authenticated read menus" on app_menus;
create policy "authenticated read menus" on app_menus for select to authenticated using (true);

-- ============================================================================
-- OUTLETS: Store/Restaurant information
-- ============================================================================
-- Each order belongs to one outlet/store. The outlet contains branding, 
-- contact info, and location data for the receipt.

create table if not exists outlets (
  id uuid not null default gen_random_uuid (),
  name text not null,
  address text null,
  phone text null,
  email text null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  gst_number text null,
  is_active boolean not null default true,
  constraint outlets_pkey primary key (id)
);
create policy "authenticated read outlets" on outlets for select to authenticated using (true);

create trigger update_outlets_updated_at BEFORE
update on outlets for EACH row
execute FUNCTION update_updated_at_column ();


create table if not exists public.tables (
  id uuid not null default gen_random_uuid (),
  outlet_id uuid not null,
  table_number text not null,
  capacity integer not null default 4,
  floor_area text null default 'Main'::text,
  status text null default 'available'::text,
  position_x integer null default 0,
  position_y integer null default 0,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint tables_pkey primary key (id),
  constraint tables_outlet_id_table_number_key unique (outlet_id, table_number),
  constraint tables_outlet_id_fkey foreign KEY (outlet_id) references outlets (id) on delete CASCADE,
  constraint tables_status_check check (
    (
      status = any (
        array[
          'available'::text,
          'occupied'::text,
          'reserved'::text,
          'cleaning'::text
        ]
      )
    )
  )
);

create policy "authenticated read tables" on tables for select to authenticated using (true);

create trigger update_tables_updated_at BEFORE
update on tables for EACH row
execute FUNCTION update_updated_at_column ();

-- ============================================================================
-- AUTH: profiles + authorization
-- ============================================================================
-- The app authenticates operators with Supabase Auth and authorizes them via
-- this profiles table: an account must have a profile row and is_active = true.

create table if not exists public.profiles (
  id uuid not null default gen_random_uuid (),
  user_id uuid not null,
  outlet_id uuid null,
  first_name text not null,
  last_name text not null,
  email text not null,
  phone text null,
  user_role text null default 'waiter'::text,
  is_active boolean null default true,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  org_id uuid null,
  constraint profiles_pkey primary key (id),
  constraint profiles_user_id_key unique (user_id),
  constraint profiles_org_id_fkey foreign KEY (org_id) references organizations (id),
  constraint profiles_outlet_id_fkey foreign KEY (outlet_id) references outlets (id) on delete CASCADE,
  constraint profiles_role_check check (
    (
      role = any (
        array[
          'admin'::text,
          'staff'::text,
          'editor'::text,
          'manager'::text,
          'cashier'::text,
          'waiter'::text,
          'kitchen_staff'::text
        ]
      )
    )
  )
);

create index IF not exists idx_profiles_org on public.profiles using btree (org_id);

create trigger update_profiles_updated_at BEFORE
update on profiles for EACH row
execute FUNCTION update_updated_at_column ();

-- A signed-in user may read and update only their own profile.
drop policy if exists "read own profile" on profiles;
create policy "read own profile" on profiles
  for select using (auth.uid() = id);

drop policy if exists "update own profile" on profiles;
create policy "update own profile" on profiles
  for update using (auth.uid() = id);

-- GST rate per outlet. The New Order page reads the newest active row for the
-- signed-in user's outlet. Only manager/owner/admin may change it.
create table if not exists tax_settings (
  id           uuid primary key default gen_random_uuid(),
  outlet_id    uuid not null references outlets(id),
  name         text not null default 'GST',
  rate_percent numeric(5,2) not null check (rate_percent >= 0 and rate_percent <= 100),
  is_active    boolean not null default true,
  updated_at   timestamptz not null default now()
);
create index if not exists idx_tax_settings_outlet on tax_settings (outlet_id, is_active, updated_at desc);

alter table tax_settings enable row level security;

drop policy if exists "staff read own outlet tax" on tax_settings;
create policy "staff read own outlet tax" on tax_settings
  for select to authenticated
  using (exists (select 1 from profiles p
                  where p.user_id = auth.uid() and p.outlet_id = tax_settings.outlet_id));

drop policy if exists "managers manage own outlet tax" on tax_settings;
create policy "managers manage own outlet tax" on tax_settings
  for all to authenticated
  using (exists (select 1 from profiles p
                  where p.user_id = auth.uid() and p.outlet_id = tax_settings.outlet_id
                    and p.role in ('manager', 'owner', 'admin')))
  with check (exists (select 1 from profiles p
                  where p.user_id = auth.uid() and p.outlet_id = tax_settings.outlet_id
                    and p.role in ('manager', 'owner', 'admin')));

-- ============================================================================
-- MULTI-TENANT FOUNDATION: organizations
-- ============================================================================
-- A tenant is an ORGANIZATION (a restaurant business); it owns one or more
-- outlets, and every profile belongs to exactly one organization. Everything
-- an admin can do is scoped to the caller's organization (see the user
-- functions in db/functions.sql). Platform staff are listed in
-- platform_admins and are deliberately NOT a profile role: nothing in the
-- desktop app can grant it.
--
-- Safe to run on an existing single-customer database: it creates one
-- default organization and assigns every existing outlet and profile to it.
create table if not exists organizations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  status        text not null default 'active' check (status in ('trial', 'active', 'suspended')),
  -- Presentation defaults for every outlet of the organization.
  currency_code text not null default 'INR',
  locale        text not null default 'en-IN',
  timezone      text not null default 'Asia/Kolkata',
  tax_label     text not null default 'GST',
  created_at    timestamptz not null default now()
);

alter table outlets  add column if not exists org_id   uuid references organizations(id);
alter table outlets  add column if not exists timezone text;   -- optional per-outlet override of the organization's
alter table profiles add column if not exists org_id   uuid references organizations(id);

do $$
declare
  v_org uuid;
begin
  if exists (select 1 from outlets where org_id is null)
     or exists (select 1 from profiles where org_id is null) then
    select id into v_org from organizations order by created_at limit 1;
    if v_org is null then
      insert into organizations (name) values ('Default organization') returning id into v_org;
    end if;
    update outlets set org_id = v_org where org_id is null;
    update profiles p
       set org_id = coalesce((select o.org_id from outlets o where o.id = p.outlet_id), v_org)
     where p.org_id is null;
  end if;
end $$;

alter table outlets alter column org_id set not null;
create index if not exists idx_outlets_org on outlets (org_id);
create index if not exists idx_profiles_org on profiles (org_id);

-- ============================================================================
-- USER GROUPS (identity-management style access)
-- ============================================================================
-- A group is a named bundle of permissions inside one organization. A user who
-- is a member of a group gets everything the group grants IN ADDITION to what
-- their role grants (groups only add; they never remove a role's access).
-- Remove the user from the group and the access goes away immediately.
--
--   user_groups         : the groups of an organization
--   group_permissions   : which permission codes a group grants
--   user_group_members  : which users belong to which group
--
-- Menus need no extra table: every sidebar entry requires a permission, so a
-- group that grants it shows the menu. All writes go through the admin
-- functions in db/functions.sql (users.manage, same organization only); there
-- are deliberately no write policies.
create table if not exists user_groups (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  description text not null default '',
  created_at  timestamptz not null default now()
);
create unique index if not exists user_groups_org_name_uq on user_groups (org_id, lower(btrim(name)));

create table if not exists group_permissions (
  group_id        uuid not null references user_groups(id) on delete cascade,
  permission_code text not null references permissions(code) on delete cascade,
  primary key (group_id, permission_code)
);

create table if not exists user_group_members (
  group_id uuid not null references user_groups(id) on delete cascade,
  user_id  uuid not null,                       -- profiles.user_id
  added_by uuid,
  added_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists user_group_members_user_idx on user_group_members (user_id);

alter table user_groups        enable row level security;
alter table group_permissions  enable row level security;
alter table user_group_members enable row level security;

drop policy if exists "admins read own org groups" on user_groups;
create policy "admins read own org groups" on user_groups
  for select to authenticated
  using (org_id = current_org_id() and has_permission('users.manage'));

drop policy if exists "admins read own org group permissions" on group_permissions;
create policy "admins read own org group permissions" on group_permissions
  for select to authenticated
  using (has_permission('users.manage')
         and exists (select 1 from user_groups g where g.id = group_id and g.org_id = current_org_id()));

drop policy if exists "admins read own org group members" on user_group_members;
create policy "admins read own org group members" on user_group_members
  for select to authenticated
  using (has_permission('users.manage')
         and exists (select 1 from user_groups g where g.id = group_id and g.org_id = current_org_id()));


create table if not exists public.app_activity_log (
   id  uuid default gen_random_uuid(),
  order_id uuid not null,
  order_item_id uuid null,
  old_quantity numeric null,
  new_quantity numeric null,
  reason text not null,
  created_at timestamp with time zone not null default now(),
  order_details json null,
  activity text not null default ''::text,
  changed_by uuid null,
  changed_at timestamp with time zone null,
  constraint log_table_pkey primary key (id),
  constraint log_table_order_id_fkey foreign KEY (order_id) references orders (id),
  constraint log_table_order_item_id_fkey foreign KEY (order_item_id) references order_items (id)
);

create policy "authenticated read app_activity_log" on app_activity_log for select to authenticated using (true);


create table if not exists public.categories (
  id uuid not null default gen_random_uuid (),
  outlet_id uuid not null,
  name text not null,
  description text null,
  sort_order integer null default 0,
  is_active boolean null default true,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint categories_pkey primary key (id),
  constraint categories_outlet_id_fkey foreign KEY (outlet_id) references outlets (id) on delete CASCADE
);

create policy "authenticated read categories" on categories for select to authenticated using (true);

create trigger update_categories_updated_at BEFORE
update on categories for EACH row
execute FUNCTION update_updated_at_column ();

-- Failed/successful approval attempts, used to throttle password guessing
-- (5 failures per username per 10 minutes). RLS on with NO policies: only the
-- security-definer verifier reads/writes it. No password is ever stored.
create table if not exists editor_approval_attempts (
  id bigint generated always as identity primary key,
  outlet_id uuid not null,
  username text not null,
  requested_by uuid null,
  succeeded boolean not null,
  attempted_at timestamptz not null default now()
);
create index if not exists idx_editor_approval_attempts_recent
  on editor_approval_attempts (outlet_id, lower(username), attempted_at desc)
  where not succeeded;
alter table editor_approval_attempts enable row level security;


-- Locked down completely: no anon/authenticated policies at all. The ONLY
-- way to read or write this table is through the security-definer functions
-- below (assign_invoice_number(), db/functions.sql's
-- get_invoice_sequence_status()/reset_invoice_sequence()), which run with
-- elevated privileges and so aren't blocked by RLS having zero policies —
-- direct client access (anon or authenticated) is not needed anywhere and
--e is fully denied.

create table if not exists public.menu_items (
  id uuid not null default gen_random_uuid (),
  outlet_id uuid not null,
  category_id uuid not null,
  name text not null,
  description text null,
  search_key character varying null,
  price numeric(10, 2) not null,
  cost_price numeric(10, 2) null,
  image_url text null,
  is_available boolean null default true,
  is_active boolean null default true,
  is_veg boolean not null default true,
  cooking_time integer null default 0,
  sort_order integer null default 0,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  container_charge numeric null default '5'::numeric,
  constraint menu_items_pkey primary key (id),
  constraint menu_items_category_id_fkey foreign KEY (category_id) references categories (id) on delete CASCADE,
  constraint menu_items_outlet_id_fkey foreign KEY (outlet_id) references outlets (id) on delete CASCADE
);

create policy "authenticated read menu_items" on menu_items for select to authenticated using (true);

create trigger update_menu_items_updated_at BEFORE
update on menu_items for EACH row
execute FUNCTION update_updated_at_column ();

create policy "insert own menu items rows"
on "public"."menu_items"
as PERMISSIVE
for INSERT
to authenticated
using (
  exists (
    select 1 from profiles p       
    where p.user_id = auth.uid() 
    and has_permission('menu.edit')    
  )
);

create policy "update own menu items rows"
on "public"."menu_items"
as PERMISSIVE
for UPDATE
to authenticated
using (
  exists (
    select 1 from profiles p       
    where p.user_id = auth.uid() 
    and has_permission('menu.edit')    
  )
);


-- create the orders table.

create table if not exists public.orders (
  id uuid not null default gen_random_uuid (),
  outlet_id uuid not null,
  table_id uuid null,
  order_number text not null,
  order_type text null default 'dine_in'::text,
  status text null default 'pending'::text,
  subtotal_amount numeric(10, 2) null default 0,
  tax_amount numeric(10, 2) null default 0,
  tax_rate numeric(10,2) not null default 0,
  discount_amount numeric(10, 2) null default 0,
  total_amount numeric(10, 2) null default 0,
  payment_status text null default 'pending'::text,
  payment_method text null,
  notes text null,
  waiter_id uuid null,
  cancelled_by uuid null,
  customer_name varchar(255) null,
  customer_phone varchar(50) null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  token_number integer null,
  container_amount numeric null default '0'::numeric,
  paid_at timestamp with time zone null,
  confirmed_at timestamp with time zone null,
  settled_at timestamp with time zone null,
  cancelled_at timestamp with time zone null,
  cancel_reason text,  
  payment_details jsonb null,
  invoice_number text null,
  constraint orders_pkey primary key (id),
  constraint orders_outlet_id_order_number_key unique (outlet_id, order_number),
  constraint orders_table_id_fkey foreign KEY (table_id) references tables (id) on delete set null,
  constraint orders_outlet_id_fkey foreign KEY (outlet_id) references outlets (id) on delete CASCADE,
  constraint orders_payment_status_check check (
    (
      payment_status = any (
        array[
          'pending'::text,
          'partial'::text,
          'completed'::text,
          'refunded'::text
        ]
      )
    )
  ),
  constraint orders_order_type_check check (
    (
      order_type = any (
        array[
          'dine_in'::text,
          'takeaway'::text,
          'delivery'::text
        ]
      )
    )
  ),
  constraint orders_status_check check (
    (
      status = any (
        array[
          'pending'::text,
          'confirmed'::text,
          'preparing'::text,
          'ready'::text,
          'served'::text,
          'completed'::text,
          'cancelled'::text
        ]
      )
    )
  )
);

create index IF not exists idx_orders_outlet_created_at on public.orders using btree (outlet_id, created_at desc) ;

create index IF not exists idx_orders_outlet_invoice_number on public.orders using btree (outlet_id, invoice_number) 
where
  (invoice_number is not null);

create index IF not exists idx_orders_outlet_settled on public.orders using btree (outlet_id, status, settled_at) ;

create index IF not exists idx_orders_outlet_completed on public.orders using btree (outlet_id, status, created_at) ;

create trigger trg_assign_invoice_number BEFORE INSERT on orders for EACH row
execute FUNCTION assign_invoice_number ();

create trigger update_orders_updated_at BEFORE
update on orders for EACH row
execute FUNCTION update_updated_at_column ();

-- ============================================================================
-- INVOICE NUMBERING
-- ============================================================================
-- Format: YYYY-MM-DD-NNNNN (today's date + a 5-digit running count, e.g.
-- "2026-09-28-00042"). Assigned automatically the moment an order is
-- INSERTed (by Android, via the anon key — see assign_invoice_number()
-- below), not at settle/complete time:
--   - dine-in: the table's FIRST order of a new sitting gets a fresh number;
--     every later round on that same table reuses it, until the table is
--     settled + fully paid (same "current batch" predicate used everywhere
--     else — list_tables_for_outlet()/fetchTableBatchOrders() — status <>
--     'cancelled' and not (completed and payment_details is not null)).
--     Once paid, the table frees and the NEXT sitting gets a new number.
--   - takeaway/pickup: every order gets its own fresh number, no reuse.
-- The running count (NNNNN) is per-outlet and does NOT reset daily — it
-- keeps climbing across days until an admin manually resets it from the
-- Settings page (reset_invoice_sequence(), db/functions.sql). Cancelled
-- orders keep whatever number they were assigned — numbers are never
-- reused or renumbered, so gaps from a cancellation are expected, not a
-- bug (standard for audit-safe invoice numbering).
alter table orders
  add column if not exists invoice_number text;

create table if not exists invoice_sequences (
  outlet_id uuid primary key references outlets(id),
  current_seq integer not null default 0,
  last_reset_at timestamptz,
  reset_by uuid references auth.users(id)
);


create table public.order_items (
  id uuid not null default gen_random_uuid (),
  order_id uuid not null,
  menu_item_id uuid not null,
  quantity integer not null default 1,
  unit_price numeric(10, 2) not null,
  total_price numeric(10, 2) not null,
  status text null default 'pending'::text,
  notes text null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  kot_printed boolean null default false,
  kot_printed_at timestamp with time zone null default now(),
  is_deleted boolean null default false,
  edited_at timestamp with time zone null,
  edited_by uuid null,
  constraint order_items_pkey primary key (id),
  constraint order_items_menu_item_id_fkey foreign KEY (menu_item_id) references menu_items (id) on delete CASCADE,
  constraint order_items_order_id_fkey foreign KEY (order_id) references orders (id) on delete CASCADE,
  constraint order_items_status_check check (
    (
      status = any (
        array[
          'pending'::text,
          'cancelled'::text,
          'confirmed'::text,
          'preparing'::text,
          'ready'::text,
          'served'::text
        ]
      )
    )
  )
);

create index IF not exists idx_order_items_order_id on public.order_items using btree (order_id) ;

create index IF not exists idx_order_items_pending on public.order_items using btree (order_id) 
where
  (kot_printed = false);

create index IF not exists idx_order_items_not_deleted on public.order_items using btree (order_id) 
where
  (not is_deleted);

create trigger update_order_items_updated_at BEFORE
update on order_items for EACH row
execute FUNCTION update_updated_at_column ();


create table public.order_sequences (
  id uuid not null default gen_random_uuid (),
  outlet_id uuid not null,
  current_number integer not null,
  starting_number integer not null,
  last_reset timestamp with time zone not null default now(),
  constraint order_sequences_pkey primary key (id),
  constraint order_sequences_outlet_id_key unique (outlet_id),
  constraint order_sequences_outlet_id_fkey foreign KEY (outlet_id) references outlets (id) on delete CASCADE
);

-- ============================================================================
-- TAX RATES: per category, effective-dated, fixed on each order line
-- ============================================================================
-- See docs/TAX_PLAN.md. Prices are tax-exclusive.
--
-- tax_rates is APPEND-ONLY. To change a rate you add a row with a later
-- effective_from; the newest row that has taken effect wins. A row with a
-- category_id applies to that category; category_id null is the outlet's
-- DEFAULT rate, used by every category without a rate of its own. A category
-- row with a null rate means "use the default from this date" (it undoes an
-- override). An explicit 0 means exempt. Rows are written only through
-- add_tax_rate() / delete_tax_rate() (tax.manage, own outlet); a row can be
-- deleted only while it is still scheduled for the future.
--
-- Every order line keeps the rate it was created with (order_items
-- .tax_rate_percent / .tax_name), so a later rate change never touches an
-- existing order. orders.tax_breakdown stores the per-rate split for the bill.
create table if not exists tax_rates (
  id             uuid primary key default gen_random_uuid(),
  outlet_id      uuid not null references outlets(id) on delete cascade,
  category_id    uuid,
  name           text not null default 'GST' check (char_length(btrim(name)) between 1 and 30),
  rate_percent   numeric(5,2) check (rate_percent is null or (rate_percent >= 0 and rate_percent <= 100)),
  effective_from timestamptz not null,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  check (category_id is not null or rate_percent is not null)
);
create unique index if not exists tax_rates_scope_time_uq
  on tax_rates (outlet_id, coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid), effective_from);
create index if not exists tax_rates_lookup_idx on tax_rates (outlet_id, category_id, effective_from desc);

do $$
begin
  if to_regclass('public.categories') is not null
     and not exists (select 1 from pg_constraint where conname = 'tax_rates_category_fk') then
    alter table tax_rates
      add constraint tax_rates_category_fk foreign key (category_id) references categories(id) on delete cascade;
  end if;
end $$;

alter table tax_rates enable row level security;

-- Reading the table is for the Tax screen (tax.manage). Everyone who places
-- orders gets the current rates through effective_tax_rates() instead.
drop policy if exists "tax managers read own outlet rates" on tax_rates;
create policy "tax managers read own outlet rates" on tax_rates
  for select to authenticated
  using (has_permission('tax.manage')
         and exists (select 1 from profiles p
                      where p.user_id = auth.uid() and p.outlet_id = tax_rates.outlet_id));

-- What each order line was taxed at, and the per-rate split of each order.
alter table order_items add column if not exists tax_rate_percent numeric(5,2);
alter table order_items add column if not exists tax_name text;
alter table orders      add column if not exists tax_breakdown jsonb;