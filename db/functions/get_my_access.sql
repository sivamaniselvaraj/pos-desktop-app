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