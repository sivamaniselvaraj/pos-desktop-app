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
        and p.role in ('manager', 'owner', 'admin')
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
        and p.role in ('manager', 'owner', 'admin')
        and p.outlet_id = o.outlet_id
        and o.status = 'open'
    )
  )
  with check (
    exists (
      select 1 from orders o
      join profiles p on p.user_id = auth.uid()
      where o.id = order_items.order_id
        and p.role in ('manager', 'owner', 'admin')
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
        and p.role in ('manager', 'owner', 'admin')
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
        and p.role in ('manager', 'owner', 'admin')
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
        and p.role in ('manager', 'owner', 'admin')
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
        and p.role in ('manager', 'owner', 'admin')
        and p.outlet_id = orders.outlet_id
    )
    and orders.status = 'open'
  )
  with check (
    exists (
      select 1 from profiles p
      where p.user_id = auth.uid()
        and p.role in ('manager', 'owner', 'admin')
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

drop trigger if exists trg_assign_invoice_number on orders;
create trigger trg_assign_invoice_number
  before insert on orders
  for each row execute function assign_invoice_number();


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
