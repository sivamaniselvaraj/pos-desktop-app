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
  ('about.view',      'See the About page'),
  ('kot.view',   'See the KOT board'),
  ('kot.move',   'Move KOTs between steps'),
  ('kot.manage', 'Change KOT steps and waiting-time colours'),
  ('orders.discount', 'Give a discount on an order or mark it complimentary')
  ('orders.complimentary', 'Mark an order complimentary (customer pays nothing)')
  ('discount.manage', 'Change the allowed discount percentages')
  ('reports.incentive', 'See the Incentive report')
on conflict (code) do nothing;

insert into app_menus (code, label, icon, sort_order, required_permission) values
  ('dashboard',    'Dashboard',    'dashboard', 10, 'dashboard.view'),
  ('new-order',    'New Order',    'plus',      20, 'orders.place'),
  ('history',      'History',      'history',   30, 'history.view'),
  ('orders-list',  'Orders',       'orders',    40, 'orders.view'),
  ('tables',       'Tables',       'table',     50, 'tables.view'),
  ('menu-items',   'Menu Items',   'foodMenu',  60, 'menu.view'),
  ('sales-report', 'Sales Report', 'reports',   70, 'reports.view'),
  ('users',        'Users',        'users',     80, 'users.manage'),
  ('settings',     'Settings',     'settings',  90, 'settings.view'),
  ('about',        'About',        'info',     100, 'about.view'),
  ('tax-rates', 'Tax', 'reports', 85, 'tax.manage')
  ('kot-board', 'KOT Board', 'menu', 45, 'kot.view')
on conflict (code) do nothing;


-- The default workflow for an outlet. Does nothing when the outlet has steps.
create or replace function seed_kot_workflow(p_outlet uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s_new uuid; s_prep uuid; s_ready uuid; s_served uuid;
begin
  if exists (select 1 from kot_statuses where outlet_id = p_outlet) then
    return;
  end if;
  insert into kot_statuses (outlet_id, code, name, color, action_label, sort_order, is_initial, is_final, show_on_board)
  values (p_outlet, 'new', 'New', '#7f8c8d', null, 10, true, false, true)
  returning id into s_new;
  insert into kot_statuses (outlet_id, code, name, color, action_label, sort_order, notify_waiter)
  values (p_outlet, 'preparing', 'Preparing', '#2980b9', 'Start preparing', 20, true)
  returning id into s_prep;
  insert into kot_statuses (outlet_id, code, name, color, action_label, sort_order, notify_waiter)
  values (p_outlet, 'ready', 'Ready', '#1e8449', 'Mark ready', 30, true)
  returning id into s_ready;
  insert into kot_statuses (outlet_id, code, name, color, action_label, sort_order, is_final, show_on_board, notify_waiter)
  values (p_outlet, 'served', 'Served', '#34495e', 'Served', 40, true, false, true)
  returning id into s_served;

  insert into kot_transitions (from_status, to_status) values
    (s_new, s_prep), (s_prep, s_ready), (s_ready, s_served),
    (s_prep, s_new), (s_ready, s_prep);

  insert into kot_time_levels (outlet_id, name, from_minutes, color, notify) values
    (p_outlet, 'On time', 0, '#1e8449', false),
    (p_outlet, 'Getting late', 10, '#f1c40f', true),
    (p_outlet, 'Late', 20, '#c0392b', false)
  on conflict do nothing;
end;
$$;
revoke all on function seed_kot_workflow(uuid) from public, anon, authenticated;

insert into permissions (code, description) values
  ('reports.menu_availability', 'See the Menu availability report (when items were turned off, why, for how long)')
on conflict (code) do nothing;

insert into permissions (code, description) values
  ('reports.incentive', 'See the By waiter report (sales and incentive per waiter)')
on conflict (code) do nothing;

insert into permissions (code, description) values
  ('menu.categories.view',   'See the menu categories'),
  ('menu.categories.manage', 'Add, rename and deactivate menu categories')
on conflict (code) do nothing;

insert into permissions (code, description) values
  ('receipt.manage', 'Change the header and footer lines printed on bills')
on conflict (code) do nothing;

insert into permissions (code, description) values
  ('branding.manage', 'Change the app colour for the whole business')
on conflict (code) do nothing;

insert into discount_presets (outlet_id, percent)
select o.id, p.percent from outlets o cross join (values (10), (20), (25)) as p(percent)
on conflict do nothing;


insert into permissions (code, description) values
  ('orders.discount', 'Give a discount on an order or mark it complimentary')
insert into permissions (code, description) values
  ('orders.complimentary', 'Mark an order complimentary (customer pays nothing)')
  insert into permissions (code, description) values
  ('discount.manage', 'Change the allowed discount percentages')


insert into app_menus (code, label, icon, sort_order, required_permission) values
  ('kot-board', 'KOT Board', 'menu', 45, 'kot.view')
on conflict (code) do nothing;

-- Unprinted KOTs: tickets that never reached the kitchen printer, with a manual print.
insert into app_menus (code, label, icon, sort_order, required_permission) values
  ('unprinted-kots', 'Unprinted KOTs', 'print', 46, 'orders.view')
on conflict (code) do nothing;


insert into permissions (code, description) values
  ('reports.voids', 'See the Voids and discounts report (every removed or cancelled item, cancelled order and discount, who did it and why)')
on conflict (code) do nothing;


-- Settings > Menu upload (docs/MENU_UPLOAD.md): add and update many menu items from an Excel or CSV
-- file. A permission of its own, separate from menu.edit. Admins always pass; other roles and
-- groups get it by ticking it in User groups.
insert into permissions (code, description) values
  ('menu.upload', 'Upload the menu from an Excel or CSV file (add and update many items)')
on conflict (code) do nothing;



-- ============================================================================
-- STAFF GROUP SEED: seed_staff_group(profile id)
-- ============================================================================
-- Adds one function, nothing else changes: run this file once on the database
-- (by hand, SQL editor or service role). Additive and safe to re-run. The same
-- function is in db/functions.sql; running either one is enough.
-- Then, for each user who should get it:
--   select seed_staff_group('<profiles.id>');
-- See docs/MULTI_TENANT_PLAN.md, section 6.

-- ---------------------------------------------------------------------------
-- seed_staff_group(profile id): seed data for one user. Makes sure the user's
-- organization has a group named "Staff" (the same group as the default Staff
-- group: names match ignoring case, one per organization), puts the user in it,
-- and gives the group users.manage. Returns the group id.
-- p_profile_id is profiles.id; the membership row uses that profile's user_id
-- (what has_permission() matches) and the profile's own org_id, so the group
-- is always in the user's organization.
-- Safe to repeat: an existing group, membership or grant is left alone and
-- nothing is duplicated; no other permission or member of the group is touched.
-- Provisioning only (service role / SQL editor), like seed_default_groups.
-- Never callable by app users: it hands out users.manage.
-- ---------------------------------------------------------------------------
create or replace function seed_staff_group(p_profile_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
  v_org  uuid;
  v_gid  uuid;
begin
  select p.user_id, p.org_id into v_user, v_org from profiles p where p.id = p_profile_id;
  if not found then
    raise exception 'Profile % not found', p_profile_id;
  end if;
  if v_user is null or v_org is null then
    raise exception 'Profile % has no login or organization', p_profile_id;
  end if;
  if not exists (select 1 from permissions where code = 'users.manage') then
    raise exception 'Permission users.manage is missing; run db/schema.sql first';
  end if;

  insert into user_groups (org_id, name, description)
  values (v_org, 'Staff', 'Default group for the staff role')
  on conflict (org_id, lower(btrim(name))) do nothing;
  select id into v_gid from user_groups where org_id = v_org and lower(btrim(name)) = 'staff';

  insert into user_group_members (group_id, user_id)
  values (v_gid, v_user)
  on conflict do nothing;

  insert into group_permissions (group_id, permission_code)
  values (v_gid, 'users.manage')
  on conflict do nothing;

  return v_gid;
end;
$$;
revoke all on function seed_staff_group(uuid) from public, anon, authenticated;

do $$
declare o record;
begin
  for o in select user_id from profiles loop
    perform seed_staff_group(o.user_id);
  end loop;
end $$;

-- The default workflow for an outlet. Does nothing when the outlet has steps.
create or replace function seed_kot_workflow(p_outlet uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s_new uuid; s_prep uuid; s_ready uuid; s_served uuid;
begin
  if exists (select 1 from kot_statuses where outlet_id = p_outlet) then
    return;
  end if;
  insert into kot_statuses (outlet_id, code, name, color, action_label, sort_order, is_initial, is_final, show_on_board)
  values (p_outlet, 'new', 'New', '#7f8c8d', null, 10, true, false, true)
  returning id into s_new;
  insert into kot_statuses (outlet_id, code, name, color, action_label, sort_order, notify_waiter)
  values (p_outlet, 'preparing', 'Preparing', '#2980b9', 'Start preparing', 20, true)
  returning id into s_prep;
  insert into kot_statuses (outlet_id, code, name, color, action_label, sort_order, notify_waiter)
  values (p_outlet, 'ready', 'Ready', '#1e8449', 'Mark ready', 30, true)
  returning id into s_ready;
  insert into kot_statuses (outlet_id, code, name, color, action_label, sort_order, is_final, show_on_board, notify_waiter)
  values (p_outlet, 'served', 'Served', '#34495e', 'Served', 40, true, false, true)
  returning id into s_served;

  insert into kot_transitions (from_status, to_status) values
    (s_new, s_prep), (s_prep, s_ready), (s_ready, s_served),
    (s_prep, s_new), (s_ready, s_prep);

  insert into kot_time_levels (outlet_id, name, from_minutes, color, notify) values
    (p_outlet, 'On time', 0, '#1e8449', false),
    (p_outlet, 'Getting late', 10, '#f1c40f', true),
    (p_outlet, 'Late', 20, '#c0392b', false)
  on conflict do nothing;
end;
$$;
revoke all on function seed_kot_workflow(uuid) from public, anon, authenticated;

do $$
declare o record;
begin
  for o in select id from outlets loop
    perform seed_kot_workflow(o.id);
  end loop;
end $$;