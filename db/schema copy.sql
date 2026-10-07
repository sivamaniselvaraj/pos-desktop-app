-- Run this in the Supabase SQL editor to create the orders table.

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  order_id varchar(50) unique not null,
  order_number integer not null,
  customer_name varchar(255) not null,
  customer_phone varchar(50),
  delivery_address text,
  items jsonb not null default '[]'::jsonb,
  subtotal decimal(10,2) not null default 0,
  tax decimal(10,2) not null default 0,
  total decimal(10,2) not null default 0,
  order_type varchar(20) not null default 'pickup',
  special_notes text,
  status varchar(20) not null default 'pending',
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- Example seed row for testing:
insert into orders (order_id, order_number, customer_name, customer_phone, delivery_address, items, subtotal, tax, total, order_type, special_notes)
values (
  'ORD-2024-001', 1, 'John Doe', '+1 555 123 4567', '123 Main St, City',
  '[{"id":"1","name":"Burger","quantity":2,"price":8.50},{"id":"2","name":"Fries","quantity":1,"price":3.99,"specialInstructions":"Extra salt"}]'::jsonb,
  20.99, 2.00, 22.99, 'delivery', 'Ring doorbell twice'
)
on conflict (order_id) do nothing;


-- ============================================================================
-- AUTH: profiles + authorization
-- ============================================================================
-- The app authenticates operators with Supabase Auth and authorizes them via
-- this profiles table: an account must have a profile row and is_active = true.

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  role text not null default 'staff',          -- e.g. 'staff' | 'admin'
  is_active boolean not null default true,
  created_at timestamptz default now()
);

alter table profiles enable row level security;

-- A signed-in user may read and update only their own profile.
drop policy if exists "read own profile" on profiles;
create policy "read own profile" on profiles
  for select using (auth.uid() = id);

drop policy if exists "update own profile" on profiles;
create policy "update own profile" on profiles
  for update using (auth.uid() = id);

-- Automatically create a profile row whenever a new auth user is created.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ----------------------------------------------------------------------------
-- Creating the first operator:
--   1. In Supabase dashboard > Authentication > Users > "Add user"
--      (set email + password; the trigger creates the profile automatically).
--   2. Optionally promote to admin / set name:
--        update profiles set role = 'admin', full_name = 'Owner'
--        where email = 'you@restaurant.com';
--   3. To disable an account without deleting it:
--        update profiles set is_active = false where email = '...';
-- ----------------------------------------------------------------------------

-- NOTE on the orders table and the print pipeline:
-- The local print HTTP endpoint runs without an operator session, so it reads
-- orders using the anon key. If you enable RLS on `orders`, add a policy that
-- permits the print path, or (recommended for production) give the desktop's
-- main process a SUPABASE_SERVICE_ROLE_KEY used only server-side for fetching
-- orders, and keep the anon key for operator auth.


-- ============================================================================
-- OUTLETS: Store/Restaurant information
-- ============================================================================
-- Each order belongs to one outlet/store. The outlet contains branding, 
-- contact info, and location data for the receipt.

create table if not exists outlets (
  id uuid primary key default gen_random_uuid(),
  name varchar(255) not null,
  city varchar(100),
  phone varchar(50),
  gst_number varchar(50),
  address text,
  is_active boolean not null default true,
  created_at timestamptz default now()
);

-- Add outlet_id to orders (if not already present).
-- Uncomment and run if your orders table doesn't have this column:
-- alter table orders add column outlet_id uuid references outlets(id);

-- Example outlets:
-- insert into outlets (name, city, phone, gst_number, address) values
--   ('Aasife Biryani - Main', 'Bengaluru', '+91 80 1234 5678', '33ABIFM6725D1ZF', 'ESI Ring Road, Hosur - 635109'),
--   ('Aasife Biryani - HSR', 'Bengaluru', '+91 80 9876 5432', '33ABIFM6725D1ZF', 'HSR Layout, Bengaluru');


-- ============================================================================
-- SETTINGS: Application configuration (per machine/operator)
-- ============================================================================
-- Stores user-configurable settings like selected printer, app preferences, etc.
-- One row per setting key-value pair, or a single row for all settings.

create table if not exists settings (
  id uuid primary key default gen_random_uuid(),
  key varchar(100) not null unique,
  value text,
  description text,
  updated_at timestamptz default now(),
  updated_by uuid references auth.users(id) on delete set null
);

-- Example initial settings:
-- insert into settings (key, value, description) values
--   ('printer_device', 'USB001', 'Default thermal printer device name'),
--   ('printer_type', 'EPSON', 'Thermal printer type (EPSON, STAR, TANCA, etc)');



-- ============================================================================
-- INCREMENTAL KOT + SETTLE support
-- ============================================================================
-- Run these migrations for the confirm->KOT (delta) and settle->bill flow.

-- Per-line-item KOT tracking. A row is printed to the kitchen exactly once,
-- on the confirm that first includes it. Increments arrive as new rows.
alter table order_items
  add column if not exists kot_printed boolean not null default false,
  add column if not exists kot_printed_at timestamptz;

-- Fast lookup of the unprinted delta for an order.
create index if not exists idx_order_items_unprinted
  on order_items (order_id) where kot_printed = false;

-- Order lifecycle: 'open' while the table is active, 'completed' once billed
-- (see get_sales_report_uid in db/functions.sql — the real orders table uses
-- 'completed', not 'settled'; this file's status/timestamp assumptions were
-- written speculatively before the real schema was confirmed and may not
-- match column-for-column — treat as documentation, verify against the
-- actual database before relying on it literally).
-- Used as the settle idempotency guard (second settle on a 'completed' order
-- is a no-op).
alter table orders
  add column if not exists status varchar(20) not null default 'open',
  add column if not exists settled_at timestamptz;

-- Table availability. 'open' = free/available for the next customer.
-- (#4: table<->order linkage is provisional; settle frees the table if the
-- order carries table_id.)
alter table tables
  add column if not exists state varchar(20) not null default 'open';


-- ============================================================================
-- SALES REPORT support
-- ============================================================================
-- Links a staff profile to the outlet whose data they see in reports. The
-- report RPCs resolve outlet + role from auth.uid() server-side — never from
-- a client-supplied parameter — so a modified client can't request another
-- outlet's figures.

alter table profiles
  add column if not exists outlet_id uuid references outlets(id);

create index if not exists idx_profiles_outlet_id on profiles (outlet_id);


-- ============================================================================
-- USER MANAGEMENT support
-- ============================================================================
alter table profiles
  add column if not exists phone varchar(30),
  add column if not exists created_at timestamptz default now();


-- ============================================================================
-- ORDERS LIST: item editing/audit trail + order cancellation
-- ============================================================================
-- Item edit/delete is a full, permanent supersede of the earlier "a separate
-- system handles bill edits after KOT, out of scope" decision — see the
-- Orders List feature discussion. Every edit/delete is now audited here.

alter table order_items
  add column if not exists is_deleted boolean not null default false,
  add column if not exists edited_at timestamptz,
  add column if not exists edited_by uuid references auth.users(id);

create table if not exists order_item_audit (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null,
  order_id uuid not null,
  action varchar(20) not null, -- 'edit' | 'delete'
  changed_by uuid references auth.users(id),
  changed_at timestamptz not null default now(),
  old_values jsonb,
  new_values jsonb
);

create index if not exists idx_order_item_audit_order_id on order_item_audit (order_id);
create index if not exists idx_order_items_not_deleted on order_items (order_id) where not is_deleted;
-- General order_id index (not the partial "not deleted" one above) — needed
-- by get_order_detail()/the activity-log RPCs, which must see deleted/
-- edited rows too, not just the not-deleted subset the partial index above
-- covers. (list_orders()'s own item_count lookup only needs not-deleted
-- rows — the partial index alone already serves it — since has_edits was
-- dropped from that query; see db/functions.sql.)
create index if not exists idx_order_items_order_id on order_items (order_id);

-- list_orders() (Orders List page) filters/sorts by outlet_id + created_at
-- and groups by invoice_number on every call; orders had NO index at all
-- before this, so every call was a full sequential scan of the whole orders
-- table — the direct cause of "canceling statement due to statement
-- timeout" once the table grew. These make the outlet-scoped date-range
-- scan and the invoice grouping both index-backed.
create index if not exists idx_orders_outlet_created_at on orders (outlet_id, created_at desc);
create index if not exists idx_orders_outlet_invoice_number
  on orders (outlet_id, invoice_number)
  where invoice_number is not null;

-- Free-text search in list_orders() is a %fragment% match on the order UUID
-- as text, which no btree index can serve (it forced a scan of the outlet's
-- whole history: ~1.4s at 1.5M orders). A trigram index makes it index-backed.
create extension if not exists pg_trgm;
create index if not exists idx_orders_id_text_trgm on orders using gin ((id::text) gin_trgm_ops);

-- Editor approval (second factor for edit/delete/cancel — see
-- verify_editor_approval() in db/functions.sql). Passwords are checked with
-- pgcrypto's crypt() against auth.users.encrypted_password (Supabase keeps
-- pgcrypto in the `extensions` schema).
create extension if not exists pgcrypto with schema extensions;

-- Failed/successful approval attempts, used to throttle password guessing
-- (5 failures per username per 10 minutes). RLS on with NO policies: only the
-- security-definer verifier reads/writes it. No password is ever stored.
create table if not exists editor_approval_attempts (
  id bigint generated always as identity primary key,
  outlet_id uuid not null,
  username text not null,
  requested_by uuid,
  succeeded boolean not null,
  attempted_at timestamptz not null default now()
);
create index if not exists idx_editor_approval_attempts_recent
  on editor_approval_attempts (outlet_id, lower(username), attempted_at desc)
  where not succeeded;
alter table editor_approval_attempts enable row level security;

-- app_activity_log: outlet-wide trail of order edits/removals/cancellations,
-- written by edit_order_item()/delete_order_item()/cancel_order() in
-- db/functions.sql (alongside order_item_audit, which the Orders List
-- activity log reads). Mirrors the columns of the table as it already exists
-- in Supabase; `create table if not exists` is a no-op there. activity is one
-- of 'edit_item' | 'delete_item' | 'cancel_order'. Assumes id and created_at
-- have defaults (the functions also set created_at explicitly). RLS is left
-- as-is on the existing table; the functions are security definer, so they
-- write regardless.
create table if not exists app_activity_log (
  id bigint generated by default as identity primary key,
  order_id uuid not null,
  order_item_id uuid,
  old_quantity numeric,
  new_quantity numeric,
  changed_by uuid,
  changed_at timestamptz,
  created_at timestamptz not null default now(),
  order_details json,
  reason text not null,
  activity text not null
);
create index if not exists idx_app_activity_log_order_id on app_activity_log (order_id);

-- Cancellation: mandatory reason, who, when — enforced in cancel_order() below.
alter table orders
  add column if not exists cancel_reason text,
  add column if not exists cancelled_by uuid references auth.users(id),
  add column if not exists cancelled_at timestamptz;


-- ============================================================================
-- TAX / CONTAINER CHARGE recompute support
-- ============================================================================
-- NEW columns (added by this migration, did not exist before):
alter table orders
  add column if not exists subtotal_amount numeric,
  add column if not exists container_charge_amount numeric;

-- order_items.container_charge is NOT added here — per-item container charge
-- is stated to already exist on the real table. If recompute_order_totals()
-- (db/functions.sql) errors on that column, that assumption was wrong —
-- same class of risk as order_items.quantity/unit_price/total_price, which
-- remain unverified too.


-- ============================================================================
-- TABLES: outlet scoping for the table-cards Dashboard view
-- ============================================================================
-- table_number and state were already real, confirmed columns (table_number
-- via get_order_with_items' join, state via closeOrderAndFreeTable/settle).
-- outlet_id was never confirmed either way — every other outlet-scoped
-- entity in this schema (orders, profiles, menu_items) has one, so this
-- follows that established pattern. If it already exists, this is a no-op.
alter table tables
  add column if not exists outlet_id uuid references outlets(id);


-- ============================================================================
-- MENU ITEMS: availability toggle ("item ran out, take it off the menu")
-- ============================================================================
-- No existing availability/active column was found anywhere in this project
-- before now — if you already have one under a different name, this creates
-- a redundant column; reconcile by telling me the real name instead.
--
-- Deliberately does NOT require any get_menu_items_for_outlet() change: that
-- RPC already does `to_jsonb(mi)` (a full-row wildcard serialize), so this
-- column flows through automatically to both the Menu page and Android's
-- /api/menu-items cache the moment it exists — no RPC edit needed for reads.
alter table menu_items
  add column if not exists is_active boolean not null default true;

-- ---------------------------------------------------------------------------
-- payment_details: records how an order was paid (method + amounts). Written
-- once via save_order_payment() (db/functions.sql) from the Table Dashboard's
-- Save button. A dine-in table is only freed (tables.state -> 'open') once
-- payment_details is set on every order in its settled-and-unpaid batch — see
-- list_tables_for_outlet()/complete_order()/save_order_payment() for the full
-- flow. null means "not yet paid".
-- ---------------------------------------------------------------------------
alter table orders
  add column if not exists payment_details jsonb;

-- ---------------------------------------------------------------------------
-- waiter_id: which staff member (profiles row) placed the order, sent by the
-- Android app on order creation. Used to print "Placed By: <name>" on the
-- KOT (see get_order_with_items() in db/functions.sql, which joins this to
-- profiles.full_name, and printKot() in src/main/printerManager.ts). Nullable
-- — orders placed before this existed, or without a resolvable staff login,
-- simply omit the line.
-- ---------------------------------------------------------------------------
alter table orders
  add column if not exists waiter_id uuid references profiles(id);


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

create table if not exists role_permissions (
  role            text not null,
  permission_code text not null references permissions(code) on delete cascade,
  primary key (role, permission_code)
);

create table if not exists app_menus (
  code                text primary key,          -- the route id the app knows about
  label               text not null,
  icon                text not null default 'info',
  sort_order          integer not null default 0,
  required_permission text references permissions(code) on delete set null,
  is_active           boolean not null default true
);

alter table permissions      enable row level security;
alter table role_permissions enable row level security;
alter table app_menus        enable row level security;

drop policy if exists "authenticated read permissions" on permissions;
create policy "authenticated read permissions" on permissions for select to authenticated using (true);
drop policy if exists "authenticated read role permissions" on role_permissions;
create policy "authenticated read role permissions" on role_permissions for select to authenticated using (true);
drop policy if exists "authenticated read menus" on app_menus;
create policy "authenticated read menus" on app_menus for select to authenticated using (true);

-- (Bootstrap version. It is replaced further down, in USER GROUPS, by the final
-- groups-only rule; the tables that rule needs do not exist yet at this point.)
-- has_permission(code): true when the caller has an active profile and either
-- is an admin (always, so these tables can never lock every admin out) or
-- their role is granted that permission. 'editor' has no grants. Stable +
-- security definer so it works inside RLS policies and functions.
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
        p.role = 'admin'
        or exists (select 1 from role_permissions rp
                    where rp.role = p.role and rp.permission_code = p_code)
      )
  );
$$;

grant execute on function has_permission(text) to authenticated;

insert into permissions (code, description) values
  ('dashboard.view',  'See the table dashboard'),
  ('orders.place',    'Place new orders'),
  ('history.view',    'See order history'),
  ('orders.view',     'See and manage the Orders list'),
  ('tables.view',     'See the tables list and toggle available/occupied'),
  ('tables.manage',   'Add, edit and delete tables'),
  ('menu.view',       'See menu items'),
  ('menu.edit',       'Add and edit menu items'),
  ('reports.view',    'See the sales report'),
  ('users.manage',    'Manage users'),
  ('orders.edit',     'Edit and delete items on open orders'),
  ('orders.cancel',   'Cancel orders and invoices'),
  ('orders.complete', 'Complete orders and record payment (settle)'),
  ('dashboard.tables','See live table cards with their orders'),
  ('tables.toggle',   'Switch a table between available and occupied'),
  ('tax.manage',      'Change GST rates'),
  ('invoicing.manage','See and reset invoice numbering'),
  ('settings.view',   'Open settings'),
  ('about.view',      'See the About page')
on conflict (code) do nothing;

insert into role_permissions (role, permission_code)
select r.role, p.code
from (values
  ('staff',   array['dashboard.view','orders.place','history.view','tables.view','tables.toggle','menu.view','settings.view','about.view']),
  ('manager', array['dashboard.view','dashboard.tables','orders.place','history.view','orders.view','orders.edit','orders.cancel','orders.complete','tables.view','tables.toggle','tables.manage','menu.view','menu.edit','reports.view','tax.manage','settings.view','about.view']),
  ('owner',   array['dashboard.view','dashboard.tables','orders.place','history.view','orders.view','orders.edit','orders.cancel','orders.complete','tables.view','tables.toggle','tables.manage','menu.view','menu.edit','reports.view','tax.manage','settings.view','about.view']),
  ('admin',   array['dashboard.view','dashboard.tables','orders.place','history.view','orders.view','orders.edit','orders.cancel','orders.complete','tables.view','tables.toggle','tables.manage','menu.view','menu.edit','reports.view','tax.manage','users.manage','invoicing.manage','settings.view','about.view'])
) as r(role, perms)
cross join lateral unnest(r.perms) as p(code)
on conflict do nothing;

insert into app_menus (code, label, icon, sort_order, required_permission) values
  ('dashboard',    'Dashboard',    'dashboard', 10, 'dashboard.view'),
  ('new-order',    'New Order',    'plus',      20, 'orders.place'),
  ('history',      'History',      'history',   30, 'history.view'),
  ('orders-list',  'Orders',       'print',     40, 'orders.view'),
  ('tables',       'Tables',       'dashboard', 50, 'tables.view'),
  ('menu-items',   'Menu Items',   'menu',      60, 'menu.view'),
  ('sales-report', 'Sales Report', 'reports',   70, 'reports.view'),
  ('users',        'Users',        'users',     80, 'users.manage'),
  ('settings',     'Settings',     'settings',  90, 'settings.view'),
  ('about',        'About',        'info',     100, 'about.view')
on conflict (code) do nothing;


alter table order_items enable row level security;
alter table order_item_audit enable row level security;
alter table orders enable row level security;

drop policy if exists "anon full access" on order_items;
create policy "anon full access" on order_items
  for all to anon using (true) with check (true);

drop policy if exists "anon full access" on order_item_audit;
create policy "anon full access" on order_item_audit
  for all to anon using (true) with check (true);

drop policy if exists "anon full access" on orders;
create policy "anon full access" on orders
  for all to anon using (true) with check (true);

-- authenticated desktop users: read/edit items only in their own outlet, and
-- only while the parent order is still open — same rule
-- edit_order_item()/delete_order_item() enforced in SQL before.
drop policy if exists "staff read own outlet order items" on order_items;
create policy "staff read own outlet order items" on order_items
  for select to authenticated
  using (
    exists (
      select 1 from orders o
      join profiles p on p.user_id = auth.uid()
      where o.id = order_items.order_id
        and has_permission('orders.view')
        and p.outlet_id = o.outlet_id
    )
  );

drop policy if exists "staff edit open order items" on order_items;
create policy "staff edit open order items" on order_items
  for update to authenticated
  using (
    exists (
      select 1 from orders o
      join profiles p on p.user_id = auth.uid()
      where o.id = order_items.order_id
        and has_permission('orders.edit')
        and p.outlet_id = o.outlet_id
        and o.status = 'open'
    )
  )
  with check (
    exists (
      select 1 from orders o
      join profiles p on p.user_id = auth.uid()
      where o.id = order_items.order_id
        and has_permission('orders.edit')
        and p.outlet_id = o.outlet_id
        and o.status = 'open'
    )
  );

drop policy if exists "staff insert own outlet audit rows" on order_item_audit;
create policy "staff insert own outlet audit rows" on order_item_audit
  for insert to authenticated
  with check (
    exists (
      select 1 from orders o
      join profiles p on p.user_id = auth.uid()
      where o.id = order_item_audit.order_id
        and has_permission('orders.edit')
        and p.outlet_id = o.outlet_id
    )
  );

drop policy if exists "staff read own outlet audit rows" on order_item_audit;
create policy "staff read own outlet audit rows" on order_item_audit
  for select to authenticated
  using (
    exists (
      select 1 from orders o
      join profiles p on p.user_id = auth.uid()
      where o.id = order_item_audit.order_id
        and has_permission('orders.view')
        and p.outlet_id = o.outlet_id
    )
  );

drop policy if exists "staff read own outlet orders" on orders;
create policy "staff read own outlet orders" on orders
  for select to authenticated
  using (
    exists (
      select 1 from profiles p
      where p.user_id = auth.uid()
        and has_permission('orders.view')
        and p.outlet_id = orders.outlet_id
    )
  );

-- Only the totals-recompute UPDATE from editOrderItem/deleteOrderItem goes
-- through this policy today, and that only ever runs right after an
-- order_items UPDATE that itself required status = 'open' — checked again
-- here in USING for defense in depth (a completed/cancelled order's totals
-- can no longer be changed this way, same as before).
drop policy if exists "staff update own outlet open orders totals" on orders;
create policy "staff update own outlet open orders totals" on orders
  for update to authenticated
  using (
    exists (
      select 1 from profiles p
      where p.user_id = auth.uid()
        and has_permission('orders.edit')
        and p.outlet_id = orders.outlet_id
    )
    and orders.status = 'open'
  )
  with check (
    exists (
      select 1 from profiles p
      where p.user_id = auth.uid()
        and has_permission('orders.edit')
        and p.outlet_id = orders.outlet_id
    )
  );


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

-- Locked down completely: no anon/authenticated policies at all. The ONLY
-- way to read or write this table is through the security-definer functions
-- below (assign_invoice_number(), db/functions.sql's
-- get_invoice_sequence_status()/reset_invoice_sequence()), which run with
-- elevated privileges and so aren't blocked by RLS having zero policies —
-- direct client access (anon or authenticated) is not needed anywhere and
-- is fully denied.
alter table invoice_sequences enable row level security;

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

  if new.order_type = 'dine-in' and new.table_id is not null then
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

drop trigger if exists trg_assign_invoice_number on orders;
create trigger trg_assign_invoice_number
  before insert on orders
  for each row execute function assign_invoice_number();


-- ============================================================================
-- TABLES MANAGEMENT page: floor + capacity, text table numbers
-- ============================================================================
-- table_number must hold strings like '1A' / '2a'. Convert only when it isn't
-- already a text type (a no-op if it is). tables.state keeps its existing
-- values: 'open' (= Available — what settle/cancel already write), plus the
-- manually-set 'occupied', 'reserved', 'cleaning'. The RPCs translate
-- 'open' <-> 'available' so the app only ever sees the four names.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tables'
      and column_name = 'table_number'
      and data_type not in ('text', 'character varying')
  ) then
    alter table tables alter column table_number type text using table_number::text;
  end if;
end $$;

alter table tables add column if not exists floor text;
alter table tables add column if not exists capacity integer;

-- The Tables page queries `tables` directly (no RPCs), so access control is
-- RLS. Enabling RLS here would lock out the anon-key path (Android settle /
-- cancel frees a table via tables.state), so — same as orders/order_items
-- above — anon keeps full access, and signed-in desktop users get access only
-- as a manager/owner/admin of the row's own outlet.
alter table tables enable row level security;

drop policy if exists "anon full access" on tables;
create policy "anon full access" on tables
  for all to anon
  using (true) with check (true);

drop policy if exists "staff manage own outlet tables" on tables;
create policy "staff manage own outlet tables" on tables
  for all to authenticated
  using (
    exists (
      select 1 from profiles p
      where p.user_id = auth.uid()
        and has_permission('tables.manage')
        and p.outlet_id = tables.outlet_id
    )
  )
  with check (
    exists (
      select 1 from profiles p
      where p.user_id = auth.uid()
        and has_permission('tables.manage')
        and p.outlet_id = tables.outlet_id
    )
  );

-- Backstops for the page's own validation. Both are skipped (with a notice)
-- if existing data would violate them, rather than failing the whole script.
do $$
begin
  create unique index if not exists uq_tables_outlet_number
    on tables (outlet_id, lower(table_number));
exception when others then
  raise notice 'uq_tables_outlet_number not created (duplicate table numbers exist?): %', sqlerrm;
end $$;

do $$
begin
  alter table tables add constraint tables_capacity_positive
    check (capacity is null or capacity > 0);
exception
  when duplicate_object then null;
  when others then raise notice 'tables_capacity_positive not added: %', sqlerrm;
end $$;

-- "Is this table in use?" lookup (live = not cancelled, not yet paid).
create index if not exists idx_orders_live_by_table
  on orders (table_id)
  where status <> 'cancelled' and payment_details is null;

-- ---------------------------------------------------------------------------
-- Staff / waiter access to the Tables page: they may VIEW their outlet's tables
-- and flip a table between Available ('open') and Occupied — nothing else.
-- RLS can't restrict WHICH columns an UPDATE touches, so the policy lets a
-- staff user update own-outlet rows and a trigger enforces the narrow rule
-- (state only, open <-> occupied, never while the table has a live order).
-- Managers/owners/admins are unaffected (the "manage" policy above, and the
-- trigger lets them through); the anon-key path (auth.uid() is null) too.
-- ---------------------------------------------------------------------------
drop policy if exists "staff view own outlet tables" on tables;
create policy "staff view own outlet tables" on tables
  for select to authenticated
  using (
    exists (
      select 1 from profiles p
      where p.user_id = auth.uid()
        and has_permission('tables.view')
        and p.outlet_id = tables.outlet_id
    )
  );

drop policy if exists "staff toggle own outlet tables" on tables;
create policy "staff toggle own outlet tables" on tables
  for update to authenticated
  using (
    exists (
      select 1 from profiles p
      where p.user_id = auth.uid()
        and has_permission('tables.toggle')
        and p.outlet_id = tables.outlet_id
    )
  )
  with check (
    exists (
      select 1 from profiles p
      where p.user_id = auth.uid()
        and has_permission('tables.toggle')
        and p.outlet_id = tables.outlet_id
    )
  );

create or replace function enforce_staff_table_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new; -- anon-key / service path (Android settle, etc.)
  end if;

  if has_permission('tables.manage') then
    return new;
  end if;

  -- Anyone else (staff): only `state` may change...
  if (to_jsonb(new) - 'state') is distinct from (to_jsonb(old) - 'state') then
    raise exception 'Staff can only change a table''s status';
  end if;
  -- ...and only between available ('open') and occupied.
  if old.state not in ('open', 'occupied') or new.state not in ('open', 'occupied') then
    raise exception 'Staff can only switch a table between available and occupied';
  end if;
  -- ...and not while it has a live (not cancelled, not yet paid) order.
  if new.state is distinct from old.state and exists (
    select 1 from orders o
    where o.table_id = old.id
      and o.status <> 'cancelled'
      and o.payment_details is null
  ) then
    raise exception 'This table has a live order, so its status can''t be changed manually';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_staff_table_update on tables;
create trigger trg_enforce_staff_table_update
  before update on tables
  for each row execute function enforce_staff_table_update();


-- ============================================================================
-- New Order page: veg/non-veg flag + GST rates
-- ============================================================================
-- menu_items had no veg/non-veg column. Existing items default to veg;
-- flag the non-veg ones once (update menu_items set is_veg = false where ...).
alter table menu_items add column if not exists is_veg boolean not null default true;

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
                    and has_permission('tax.manage')))
  with check (exists (select 1 from profiles p
                  where p.user_id = auth.uid() and p.outlet_id = tax_settings.outlet_id
                    and has_permission('tax.manage')));

-- Seed example (run once per outlet with your real outlet id):
--   insert into tax_settings (outlet_id, name, rate_percent) values ('<outlet uuid>', 'GST', 5);


-- ============================================================================
-- menu_items: RLS for the Menu Items add/edit modal (direct queries)
-- ============================================================================
-- The desktop app now inserts/updates menu_items directly (no RPC). Same
-- pattern as `tables`: anon keeps today's unrestricted behaviour (the Android
-- path), authenticated users can read their own outlet's items, and only
-- manager/owner/admin of that outlet can write.
alter table menu_items enable row level security;

drop policy if exists "anon full access" on menu_items;
create policy "anon full access" on menu_items
  for all to anon using (true) with check (true);

drop policy if exists "staff view own outlet menu" on menu_items;
create policy "staff view own outlet menu" on menu_items
  for select to authenticated
  using (exists (select 1 from profiles p
                  where p.user_id = auth.uid() and p.outlet_id = menu_items.outlet_id));

drop policy if exists "managers manage own outlet menu" on menu_items;
create policy "managers manage own outlet menu" on menu_items
  for all to authenticated
  using (exists (select 1 from profiles p
                  where p.user_id = auth.uid() and p.outlet_id = menu_items.outlet_id
                    and has_permission('menu.edit')))
  with check (exists (select 1 from profiles p
                  where p.user_id = auth.uid() and p.outlet_id = menu_items.outlet_id
                    and has_permission('menu.edit')));

-- Sensible limits on the new numeric fields.
alter table menu_items drop constraint if exists menu_items_price_nonneg;
alter table menu_items add constraint menu_items_price_nonneg check (price >= 0) not valid;
alter table menu_items drop constraint if exists menu_items_container_pct;
alter table menu_items add constraint menu_items_container_pct
  check (container_charge is null or (container_charge >= 0 and container_charge <= 100)) not valid;



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

-- Platform staff (you), managed only with SQL / the service role.
create table if not exists platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table platform_admins enable row level security;   -- no policies: unreadable from the app

-- Categories are per organization (the table may be shared by every customer
-- today, so existing rows go to the default organization).
do $$
begin
  if to_regclass('public.categories') is not null then
    alter table categories add column if not exists org_id uuid references organizations(id);
    update categories
       set org_id = (select id from organizations order by created_at limit 1)
     where org_id is null;
  end if;
end $$;

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

create or replace function is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from platform_admins pa where pa.user_id = auth.uid());
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

-- ---------------------------------------------------------------------------
-- Integrity: a profile's organization always equals its outlet's organization
-- ---------------------------------------------------------------------------
create or replace function enforce_profile_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outlet_org uuid;
begin
  if new.outlet_id is not null then
    select o.org_id into v_outlet_org from outlets o where o.id = new.outlet_id;
    if v_outlet_org is null then
      raise exception 'Unknown outlet';
    end if;
    if new.org_id is not null and new.org_id <> v_outlet_org then
      raise exception 'The outlet belongs to a different organization';
    end if;
    new.org_id := v_outlet_org;
  elsif new.org_id is null then
    -- No outlet: inherit the creating admin's organization, if there is one.
    new.org_id := current_org_id();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_profile_org on profiles;
create trigger trg_enforce_profile_org
  before insert or update of outlet_id, org_id on profiles
  for each row execute function enforce_profile_org();

-- A menu item may only use a category of its own organization.
create or replace function enforce_menu_item_category_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cat_org uuid;
  v_outlet_org uuid;
begin
  execute 'select org_id from categories where id = $1' into v_cat_org using new.category_id;
  select o.org_id into v_outlet_org from outlets o where o.id = new.outlet_id;
  if v_cat_org is not null and v_outlet_org is not null and v_cat_org <> v_outlet_org then
    raise exception 'That category belongs to a different organization';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_menu_item_category_org on menu_items;
create trigger trg_menu_item_category_org
  before insert or update of category_id, outlet_id on menu_items
  for each row execute function enforce_menu_item_category_org();

-- Organizations are readable by their own members only; no write policies
-- (organizations are created and changed by platform staff with SQL).
alter table organizations enable row level security;
drop policy if exists "members read own organization" on organizations;
create policy "members read own organization" on organizations
  for select to authenticated
  using (id = current_org_id());


-- ---------------------------------------------------------------------------
-- caller_may_access_outlet(): tenant guard for the RPCs that take an outlet or
-- order id (get_order_with_items, get_outlet_by_id, get_pending_kot_items,
-- mark_kot_printed, mark_order_kot_printed, get_menu_items_for_outlet).
--   * signed-in caller  -> only their own outlet (their profile's outlet_id)
--   * no session (anon) -> true, so today's Android/desktop print path keeps
--     working. db/migrations/lockdown_anon.sql revokes anon EXECUTE on these
--     functions, which closes that path for good.
-- ---------------------------------------------------------------------------
create or replace function caller_may_access_outlet(p_outlet_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.uid() is null then true
    else exists (
      select 1 from profiles p
       where p.user_id = auth.uid()
         and coalesce(p.is_active, true)
         and p.outlet_id = p_outlet_id
    )
  end;
$$;

grant execute on function caller_may_access_outlet(uuid) to anon, authenticated;


-- ============================================================================
-- OUTLETS and CATEGORIES: row-level security
-- ============================================================================
-- The desktop app reads these with plain queries (no wrapper functions), so the
-- tenant boundary is enforced here. anon keeps today's access (the legacy
-- Android path, same as orders/tables/menu_items); a signed-in user sees only
-- their own organization's rows. Writes to both tables are done with SQL or
-- the service role (provisioning), never from the app.
alter table outlets enable row level security;

drop policy if exists "anon read outlets" on outlets;
create policy "anon read outlets" on outlets for select to anon using (true);

drop policy if exists "members read own org outlets" on outlets;
create policy "members read own org outlets" on outlets
  for select to authenticated
  using (org_id = current_org_id());

do $$
begin
  if to_regclass('public.categories') is not null then
    alter table categories enable row level security;

    drop policy if exists "anon full access" on categories;
    create policy "anon full access" on categories for all to anon using (true) with check (true);

    drop policy if exists "members read own org categories" on categories;
    create policy "members read own org categories" on categories
      for select to authenticated using (org_id = current_org_id());
  end if;
end $$;


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
-- Default groups: one per role template (Staff, Manager, Owner), seeded from
-- role_permissions, so a new organization starts with sensible groups.
-- Call seed_default_groups(<org id>) when provisioning an organization.
-- Safe to repeat: existing groups are left alone.
-- ---------------------------------------------------------------------------
create or replace function seed_default_groups(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r text;
  gid uuid;
begin
  foreach r in array array['staff', 'manager', 'owner'] loop
    insert into user_groups (org_id, name, description)
    values (p_org, initcap(r), 'Default group for the ' || r || ' role')
    on conflict (org_id, lower(btrim(name))) do nothing;

    select id into gid from user_groups where org_id = p_org and lower(btrim(name)) = r;
    insert into group_permissions (group_id, permission_code)
    select gid, rp.permission_code from role_permissions rp where rp.role = r
    on conflict do nothing;
  end loop;
end;
$$;
-- Provisioning only (service role / SQL editor). Never callable by app users.
revoke all on function seed_default_groups(uuid) from public, anon, authenticated;

-- One-time switch to groups-only access. Runs only the first time groups are
-- introduced (no group exists yet): creates the default groups for every
-- organization and puts each existing staff/manager/owner user in the group
-- matching their role, so nobody loses access. Admins need no group.
do $$
declare
  o record;
begin
  if not exists (select 1 from user_groups) then
    for o in select id from organizations loop
      perform seed_default_groups(o.id);
    end loop;
    insert into user_group_members (group_id, user_id)
    select g.id, p.user_id
    from profiles p
    join user_groups g on g.org_id = p.org_id and lower(g.name) = p.role
    where p.role in ('staff', 'manager', 'owner')
    on conflict do nothing;
  end if;
end $$;
