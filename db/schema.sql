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
