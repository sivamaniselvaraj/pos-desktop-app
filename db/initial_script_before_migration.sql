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
  city varchar(100) null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  gst_number text null,
  is_active boolean not null default true,
  constraint outlets_pkey primary key (id)
);

create trigger update_outlets_updated_at BEFORE
update on outlets for EACH row
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
  constraint profiles_outlet_id_fkey foreign KEY (outlet_id) references outlets (id) on delete CASCADE
);

create trigger update_profiles_updated_at BEFORE
update on profiles for EACH row
execute FUNCTION update_updated_at_column ();

-- 1. Create a reusable function that sets updated_at to now()
create or replace function update_updated_at_column()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

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

create table if not exists permissions (
  code        text primary key,
  description text not null default ''
);

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
      and o.status not in ('cancelled', 'completed')
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

-- Platform staff (you), managed only with SQL / the service role.
create table if not exists platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table platform_admins enable row level security; 

create or replace function is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from platform_admins pa where pa.user_id = auth.uid());
$$;