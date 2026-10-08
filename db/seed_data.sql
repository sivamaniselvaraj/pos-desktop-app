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
on conflict (code) do nothing;
on conflict (code) do nothing;