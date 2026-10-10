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
  ('kot.manage', 'Change KOT steps and waiting-time colours')
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


insert into kot_statuses (outlet_id, code, name, color, action_label, sort_order, is_initial, is_final, show_on_board)
  values (p_outlet, 'new', 'New', '#7f8c8d', null, 10, true, false, true)
  insert into kot_statuses (outlet_id, code, name, color, action_label, sort_order)
  values (p_outlet, 'preparing', 'Preparing', '#2980b9', 'Start preparing', 20)
  insert into kot_statuses (outlet_id, code, name, color, action_label, sort_order)
  values (p_outlet, 'ready', 'Ready', '#1e8449', 'Mark ready', 30)
  insert into kot_statuses (outlet_id, code, name, color, action_label, sort_order, is_final, show_on_board)
  values (p_outlet, 'served', 'Served', '#34495e', 'Served', 40, true, false)
  on conflict do nothing;

  insert into kot_transitions (from_status, to_status) values
    (s_new, s_prep), (s_prep, s_ready), (s_ready, s_served),
    (s_prep, s_new), (s_ready, s_prep);

  insert into kot_time_levels (outlet_id, name, from_minutes, color) values
    (p_outlet, 'On time', 0, '#1e8449'),
    (p_outlet, 'Getting late', 10, '#f1c40f'),
    (p_outlet, 'Late', 20, '#c0392b')
  on conflict do nothing;