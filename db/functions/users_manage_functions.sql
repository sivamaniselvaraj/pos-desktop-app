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
    select 1 from profiles p where p.user_id = auth.uid() and p.role = 'admin'
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
  first_name text,
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
  select
    pr.user_id,
    pr.email,
    pr.first_name,
    pr.phone,
    pr.role,
    pr.is_active,
    pr.outlet_id,
    o.name as outlet_name,
    pr.created_at
  from profiles pr
  left join outlets o on o.id = pr.outlet_id
  where exists (
    select 1 from profiles me where me.user_id = auth.uid() and me.role = 'admin'
  )
  order by pr.first_name nulls last, pr.email;
$$;

grant execute on function list_users() to authenticated;


-- ---------------------------------------------------------------------------
-- update_user_profile(): admin edits another user's profile fields.
-- Deliberately does NOT touch email or password — changing the login itself
-- goes through the Auth Admin API (application code), not this function.
-- ---------------------------------------------------------------------------
create or replace function update_user_profile(
  p_user_id uuid,
  p_first_name text,
  p_phone text,
  p_role text,
  p_outlet_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from profiles me where me.user_id = auth.uid() and me.role = 'admin') then
    raise exception 'Only admins can update user profiles';
  end if;

  update profiles
     set first_name = p_first_name,
         phone = p_phone,
         role = p_role,
         outlet_id = p_outlet_id
   where user_id = p_user_id;
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
begin
  if not exists (select 1 from profiles me where me.user_id = auth.uid() and me.role = 'admin') then
    raise exception 'Only admins can change user status';
  end if;

  update profiles set is_active = p_is_active where user_id = p_user_id;
end;
$$;

grant execute on function set_user_active(uuid, boolean) to authenticated;


-- ---------------------------------------------------------------------------
-- list_outlets(): minimal id/name list for populating the outlet dropdown in
-- the user-management form. Not admin-gated — outlet names aren't sensitive
-- and other parts of the app may reasonably need this list too.
-- ---------------------------------------------------------------------------
create or replace function list_outlets()
returns table (id uuid, name text)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, o.name from outlets o order by o.name;
$$;

grant execute on function list_outlets() to authenticated;