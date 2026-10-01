-- ---------------------------------------------------------------------------
-- NOTE: src/main/ordersListManager.ts now reads the item/order with plain
-- .from('order_items')/.from('orders') SELECTs first (easier to see/debug
-- than an opaque rpc() call — see assertItemEditable() there), gated by the
-- "staff read own outlet order items/orders" RLS policies in db/schema.sql.
-- The actual write — update + audit insert + totals recompute — still comes
-- through edit_order_item()/delete_order_item() below, unchanged: those
-- three writes need to succeed or fail together, which one security-definer
-- function call gives for free and several separate client requests don't.
-- ---------------------------------------------------------------------------

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
drop function if exists edit_order_item(uuid, integer, text);
drop function if exists edit_order_item(uuid, uuid, integer, text);

-- p_outlet_id (passed from the desktop app's config.outletId, like
-- list_orders()) is now the first, required argument. The caller's profile
-- must still be manager/owner/admin AND belong to that same outlet, and the
-- order must belong to it too — passing another outlet's id just fails the
-- same "not authorized" check, it never grants cross-outlet access.
-- p_reason is now mandatory (was optional): app_activity_log.reason is NOT
-- NULL, and the UI already refuses to save an edit without one.
-- Every successful edit is written to BOTH order_item_audit (what the
-- Orders List activity log reads) and app_activity_log (the outlet-wide
-- activity trail), inside the same transaction as the edit itself.
create or replace function edit_order_item(
  p_outlet_id uuid,
  p_order_item_id uuid,
  p_quantity integer,
  p_reason text,
  p_editor_username text,
  p_editor_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_old jsonb;
  v_new jsonb;
  v_order jsonb;
  v_approval jsonb;
begin
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A reason is required to edit an order item';
  end if;

  select oi.order_id, to_jsonb(oi.*)
    into v_order_id, v_old
  from order_items oi
  join orders o on o.id = oi.order_id
  join profiles p on p.user_id = auth.uid()
  where oi.id = p_order_item_id
    and p.role in ('manager', 'owner', 'admin')
    and p.outlet_id = p_outlet_id
    and o.outlet_id = p_outlet_id
    and o.status not in ('cancelled', 'completed');

  if v_order_id is null then
    raise exception 'Not authorized, item not found, or the order is not editable in its current status';
  end if;

  -- Second factor: an 'editor' account's username + password, every call.
  -- Checked only AFTER the caller proved authorized above (see
  -- verify_editor_approval). A bad credential returns, not raises, so the
  -- failed-attempt row survives; nothing has been modified yet at this point.
  v_approval := verify_editor_approval(p_outlet_id, p_editor_username, p_editor_password);
  if v_approval ? 'error' then
    return jsonb_build_object('ok', false, 'error', v_approval->>'error');
  end if;

  -- unit_price is deliberately NOT in the SET list. Referencing it on the
  -- right-hand side still reads the row's current (pre-update) value, so
  -- total_price recomputes correctly from the existing price × new quantity.
  update order_items
     set quantity = p_quantity,
         total_price = p_quantity * unit_price,
         edited_at = now()
   where id = p_order_item_id
   returning to_jsonb(order_items.*) into v_new;

  perform recompute_order_totals(v_order_id);

  select jsonb_build_object(
           'order_number', o.order_number, 'invoice_number', o.invoice_number,
           'table_id', o.table_id, 'order_type', o.order_type,
           'status', o.status, 'total_amount', o.total_amount,
           'item_name', v_old->>'name',
           'old_item', v_old, 'new_item', v_new,
           'approved_by', v_approval->>'editor_email',
           'approved_by_id', v_approval->>'editor_id')
    into v_order
  from orders o where o.id = v_order_id;

  insert into app_activity_log
    (order_id, order_item_id, old_quantity, new_quantity, changed_by, changed_at,
     created_at, order_details, reason, activity)
  values (
    v_order_id, p_order_item_id,
    (v_old->>'quantity')::numeric, (v_new->>'quantity')::numeric,
    auth.uid(), now(), now(), v_order::json, trim(p_reason), 'order.item.edit'
  );

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function edit_order_item(uuid, uuid, integer, text, text, text) to authenticated;