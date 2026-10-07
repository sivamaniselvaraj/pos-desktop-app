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