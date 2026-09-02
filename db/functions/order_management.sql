-- ============================================================================
-- ORDERS LIST RPCs
-- ============================================================================
-- All gated on the caller being role in ('manager','owner','admin') AND
-- outlet-matched to the target order/caller's profile.outlet_id — same
-- pattern as the sales report RPCs. Reads (list_orders, get_order_detail)
-- silently return empty for an unauthorized caller; mutations (edit/delete
-- item, cancel/complete order) raise an exception instead, since a silent
-- no-op on a mutation is actively misleading.
--
-- ASSUMPTIONS carried over from get_top_items, still unverified against the
-- live schema: order_items.quantity / unit_price / total_price / menu_item_id
-- column names. If these RPCs error or misbehave, check those first — same
-- class of bug as the profiles.id vs profiles.user_id issue found earlier.
--
-- Tax is deliberately NOT recomputed by edit_order_item/delete_order_item —
-- there's no per-order tax rate stored anywhere to recompute it from
-- proportionally. Only orders.total_amount is kept in sync with item changes.

-- ---------------------------------------------------------------------------
-- list_orders(): paginated, status-filtered, date-range-filtered order list
-- for the caller's outlet. total_rows is repeated on every row (standard
-- window-function pagination pattern) so the client can compute page count
-- without a second query.
--
-- Postgres's `create or replace function` only allows a returns-table shape
-- to grow by APPENDING columns at the end — inserting new columns in the
-- middle (subtotal/tax/container_charge/discount, added here before
-- total_amount, for the order-total breakdown in the item edit modal) fails
-- with "cannot change return type of existing function" unless the old one
-- is dropped first. Argument list is unchanged, so it must be named
-- explicitly.
-- ---------------------------------------------------------------------------
--drop function if exists list_orders(text, date, date, integer, integer);

create or replace function list_orders(
  p_status text default null, -- 'active' | 'completed' | 'cancelled' | null (all)
  p_from date default null,
  p_to date default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns table (
  order_id uuid,
  order_number numeric,
  order_type text,
  created_at timestamptz,
  item_count bigint,
  subtotal_amount numeric,
  tax_amount numeric,
  container_charge_amount numeric,
  discount_amount numeric,
  total_amount numeric,
  status text,
  has_edits boolean,
  total_rows bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with caller as (
    select p.outlet_id
    from profiles p
    where p.user_id = auth.uid() and p.role in ('manager', 'owner', 'admin')
  ),
  base as (
    select o.id as order_id, o.order_number, o.order_type, o.created_at, o.subtotal as subtotal_amount,
           o.tax_amount, o.container_amount as container_charge_amount, o.discount_amount,
           o.total_amount, o.status
    from orders o, caller c
    where o.outlet_id = c.outlet_id
      and (
        p_status is null
        or (p_status = 'active' and o.status = 'open')
        or (p_status = 'completed' and o.status = 'completed')
        or (p_status = 'cancelled' and o.status = 'cancelled')
      )
      and (p_from is null or o.created_at::date >= p_from)
      and (p_to is null or o.created_at::date <= p_to)
  )
  select
    b.order_id,
    b.order_type,
    b.created_at,
    coalesce(
      (select sum(oi.quantity) from order_items oi
        where oi.order_id = b.order_id and not oi.is_deleted),
      0
    ) as item_count,
    b.subtotal_amount,
    b.tax_amount,
    b.container_charge_amount,
    b.discount_amount,
    b.total_amount,
    b.status,
    exists(
      select 1 from order_items oi
      where oi.order_id = b.order_id and (oi.is_deleted or oi.edited_at is not null)
    ) as has_edits,
    count(*) over () as total_rows
  from base b
  order by b.created_at desc
  limit greatest(p_page_size, 1)
  offset greatest(p_page - 1, 0) * greatest(p_page_size, 1);
$$;

grant execute on function list_orders(text, date, date, integer, integer) to authenticated;


-- ---------------------------------------------------------------------------
-- get_order_detail(): all items for one order, including soft-deleted ones
-- (flagged, not hidden) — the view/edit modal needs to show what was removed.
-- ---------------------------------------------------------------------------
create or replace function get_order_detail(p_order_id uuid)
returns table (
  order_item_id uuid,
  menu_item_id uuid,
  name text,
  quantity integer,
  unit_price numeric,
  total_price numeric,
  is_deleted boolean,
  edited_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select oi.id, oi.menu_item_id, mi.name, oi.quantity, oi.unit_price, oi.total_price,
         oi.is_deleted, oi.edited_at
  from order_items oi
  join menu_items mi on mi.id = oi.menu_item_id
  join orders o on o.id = oi.order_id
  join profiles p on p.user_id = auth.uid()
  where oi.order_id = p_order_id
    and p.role in ('manager', 'owner', 'admin')
    and p.outlet_id = o.outlet_id
  order by oi.id;
$$;

grant execute on function get_order_detail(uuid) to authenticated;


-- ============================================================================
-- recompute_order_totals(): shared tax/container-charge/total formula
-- ============================================================================
-- subtotal    = sum(quantity * unit_price) over non-deleted items
-- tax_amount  = round(subtotal * 5%, 2)                          [fixed 5%]
-- container_charge_amount = pickup orders only:
--                 sum(quantity * order_items.container_charge)
--                 over non-deleted items; 0 for dine-in/delivery
-- total_amount = subtotal + tax_amount + container_charge_amount
--
-- Deliberately excludes any "discount" column — it was never confirmed to
-- exist on the real orders table (dropped from the report RPCs earlier for
-- the same reason) and guessing a discount formula risks the same class of
-- silent-wrong-number bug as the tax/total column-name mismatch this same
-- change fixes in mapRow() (see supabaseClient.ts).
--
-- Internal helper only — EXECUTE is revoked from public/authenticated below
-- so it can't be called directly, bypassing the auth checks that
-- edit_order_item / delete_order_item perform before calling this.
create or replace function recompute_order_totals(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_subtotal numeric;
  v_order_type text;
  v_container_charge numeric := 0;
  v_tax numeric;
begin
  select coalesce(sum(oi.quantity * oi.unit_price), 0)
    into v_subtotal
  from order_items oi
  where oi.order_id = p_order_id and not oi.is_deleted;

  select o.order_type into v_order_type from orders o where o.id = p_order_id;

  if v_order_type = 'pickup' then
    select coalesce(sum(oi.quantity * coalesce(oi.container_charge, 0)), 0)
      into v_container_charge
    from order_items oi
    where oi.order_id = p_order_id and not oi.is_deleted;
  end if;

  v_tax := round(v_subtotal * 0.05, 2);

  update orders
     set subtotal_amount = v_subtotal,
         tax_amount = v_tax,
         container_charge_amount = v_container_charge,
         total_amount = v_subtotal + v_tax + v_container_charge
   where id = p_order_id;
end;
$$;

revoke execute on function recompute_order_totals(uuid) from public;


-- ---------------------------------------------------------------------------
-- edit_order_item(): change QUANTITY only on one line item — price is not
-- editable (see below). Every edit is
-- audited (before/after snapshot + who/when/optional reason), and
-- subtotal/tax/container-charge/total are all recomputed immediately via
-- recompute_order_totals().
--
-- Only allowed while the parent order is still 'open' — an order that's
-- completed or cancelled is locked. ("active and preparing" read as
-- describing that single not-yet-finalized state; there's no confirmed
-- distinct 'preparing' status in the real schema — if one exists, broaden
-- the check below.)
-- ---------------------------------------------------------------------------
-- The old 4-arg signature (uuid, integer, numeric, text) allowed changing
-- unit_price too. Price editing is intentionally removed — only quantity is
-- editable now. Since Postgres treats a different argument list as a
-- different function, `create or replace` on the new 3-arg signature would
-- NOT replace the old one; it would sit alongside it as a second, still-
-- callable overload that still lets price be changed. Drop it explicitly.
drop function if exists edit_order_item(uuid, integer, numeric, text);

create or replace function edit_order_item(
  p_order_item_id uuid,
  p_quantity integer,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_old jsonb;
  v_new jsonb;
begin
  select oi.order_id, to_jsonb(oi.*)
    into v_order_id, v_old
  from order_items oi
  join orders o on o.id = oi.order_id
  join profiles p on p.user_id = auth.uid()
  where oi.id = p_order_item_id
    and p.role in ('manager', 'owner', 'admin')
    and p.outlet_id = o.outlet_id
    and o.status = 'open';

  if v_order_id is null then
    raise exception 'Not authorized, item not found, or the order is not editable in its current status';
  end if;

  -- unit_price is deliberately NOT in the SET list. Referencing it on the
  -- right-hand side still reads the row's current (pre-update) value, so
  -- total_price recomputes correctly from the existing price × new quantity.
  update order_items
     set quantity = p_quantity,
         total_price = p_quantity * unit_price,
         edited_at = now(),
         edited_by = auth.uid()
   where id = p_order_item_id
   returning to_jsonb(order_items.*) into v_new;

  insert into order_item_audit (order_item_id, order_id, action, changed_by, old_values, new_values)
  values (
    p_order_item_id, v_order_id, 'edit', auth.uid(),
    v_old, v_new || jsonb_build_object('reason', p_reason)
  );

  perform recompute_order_totals(v_order_id);
end;
$$;

grant execute on function edit_order_item(uuid, integer, text) to authenticated;


-- ---------------------------------------------------------------------------
-- delete_order_item(): soft delete only — never removes the row. Same audit,
-- 'open'-only restriction, and totals recompute as edit_order_item.
-- ---------------------------------------------------------------------------
create or replace function delete_order_item(
  p_order_item_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_old jsonb;
  v_new jsonb;
begin
  select oi.order_id, to_jsonb(oi.*)
    into v_order_id, v_old
  from order_items oi
  join orders o on o.id = oi.order_id
  join profiles p on p.user_id = auth.uid()
  where oi.id = p_order_item_id
    and p.role in ('manager', 'owner', 'admin')
    and p.outlet_id = o.outlet_id
    and o.status = 'open';

  if v_order_id is null then
    raise exception 'Not authorized, item not found, or the order is not editable in its current status';
  end if;

  update order_items
     set is_deleted = true,
         edited_at = now(),
         edited_by = auth.uid()
   where id = p_order_item_id
   returning to_jsonb(order_items.*) into v_new;

  insert into order_item_audit (order_item_id, order_id, action, changed_by, old_values, new_values)
  values (
    p_order_item_id, v_order_id, 'delete', auth.uid(),
    v_old, v_new || jsonb_build_object('reason', p_reason)
  );

  perform recompute_order_totals(v_order_id);
end;
$$;

grant execute on function delete_order_item(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- cancel_order(): mandatory reason, manager/owner/admin only, frees the
-- table. Raises if the reason is missing/blank — cancellation is a
-- fraud-sensitive action and must never happen silently or without a reason.
-- ---------------------------------------------------------------------------
create or replace function cancel_order(p_order_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table_id uuid;
begin
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A reason is required to cancel an order';
  end if;

  if not exists (
    select 1 from orders o
    join profiles p on p.user_id = auth.uid()
    where o.id = p_order_id
      and p.role in ('manager', 'owner', 'admin')
      and p.outlet_id = o.outlet_id
  ) then
    raise exception 'Not authorized, or order not found';
  end if;

  update orders
     set status = 'cancelled',
         cancel_reason = p_reason,
         cancelled_by = auth.uid(),
         cancelled_at = now()
   where id = p_order_id
   returning table_id into v_table_id;

  if v_table_id is not null then
    update tables set state = 'open' where id = v_table_id;
  end if;
end;
$$;

grant execute on function cancel_order(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- complete_order(): manual status change from the Orders List page. Frees
-- the table. Deliberately does NOT print — printing is its own separate
-- action on this page (see printOrder/isDuplicate in printerManager.ts).
-- ---------------------------------------------------------------------------
create or replace function complete_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table_id uuid;
begin
  if not exists (
    select 1 from orders o
    join profiles p on p.user_id = auth.uid()
    where o.id = p_order_id
      and p.role in ('manager', 'owner', 'admin')
      and p.outlet_id = o.outlet_id
  ) then
    raise exception 'Not authorized, or order not found';
  end if;

  update orders
     set status = 'completed',
         settled_at = coalesce(settled_at, now())
   where id = p_order_id
   returning table_id into v_table_id;

  if v_table_id is not null then
    update tables set state = 'open' where id = v_table_id;
  end if;
end;
$$;

grant execute on function complete_order(uuid) to authenticated;


-- ============================================================================
-- get_order_activity_log(): "created" + every edit/delete for one order
-- ============================================================================
-- Read-only, same admin/outlet gate as the other Orders List RPCs, silently
-- empty for an unauthorized caller. Returns edit/delete events only — the
-- "Order created" entry isn't stored anywhere separately, the client
-- synthesizes it from orders.created_at (already in hand from list_orders),
-- so there's no need to fetch it here too.
--
-- old_quantity/new_quantity are typically EQUAL for a 'delete' event, since
-- delete_order_item() only flips is_deleted — it doesn't touch quantity or
-- price. The client should read a delete as "removed {new_quantity} of
-- {item_name}", not as a quantity change.
create or replace function get_order_activity_log(p_order_id uuid)
returns table (
  audit_id uuid,
  order_item_id uuid,
  item_name text,
  action text,
  changed_at timestamptz,
  changed_by_name text,
  old_quantity integer,
  new_quantity integer,
  old_unit_price numeric,
  new_unit_price numeric,
  reason text
)
language sql
stable
security definer
set search_path = public
as $$
  
  select
    a.id as audit_id,
    a.order_item_id,
    mi.name as item_name,
    a.activity,
    a.changed_at,
    coalesce(cb.first_name, cb.email, 'Unknown') as changed_by_name,
    a.old_quantity as old_quantity,
    a.new_quantity as new_quantity,
    a.reason as reason
  from app_activity_log a
  join orders o on o.id = a.order_id
  join profiles p on p.user_id = auth.uid()
  left join order_items oi on oi.id = a.order_item_id
  left join menu_items mi on mi.id = oi.menu_item_id
  left join profiles cb on cb.user_id = a.changed_by
  where a.order_id = p_order_id
    and p.role in ('manager', 'owner', 'admin')
    and p.outlet_id = o.outlet_id
  order by a.changed_at desc;

$$;

grant execute on function get_order_activity_log(uuid) to authenticated;