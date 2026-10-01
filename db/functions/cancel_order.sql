-- ---------------------------------------------------------------------------
-- cancel_order(): mandatory reason, manager/owner/admin only. Frees the
-- table ONLY if no other still-open order remains on it — a table can now
-- carry several dine-in orders at once (separate rounds), and cancelling one
-- of them must not release a table that's still active for the others. See
-- complete_order()/save_order_payment() below for the matching table-batch
-- model. Raises if the reason is missing/blank — cancellation is a
-- fraud-sensitive action and must never happen silently or without a reason.
-- ---------------------------------------------------------------------------
drop function if exists cancel_order(uuid, text);
drop function if exists cancel_order(uuid, uuid, text);

-- p_outlet_id: same explicit-outlet rule as edit_order_item/list_orders —
-- caller must be manager/owner/admin of THAT outlet and the order must
-- belong to it. The cancellation is also recorded in app_activity_log.
create or replace function cancel_order(
  p_outlet_id uuid,
  p_order_id uuid,
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
  v_table_id uuid;
  v_order jsonb;
  v_approval jsonb;
begin
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A reason is required to cancel an order';
  end if;

  if not exists (
    select 1 from orders o
    join profiles p on p.user_id = auth.uid()
    where o.id = p_order_id
      and p.role in ('manager', 'owner', 'admin')
      and p.outlet_id = p_outlet_id
      and o.outlet_id = p_outlet_id
  ) then
    raise exception 'Not authorized, or order not found';
  end if;

  -- Second factor — see edit_order_item / verify_editor_approval.
  v_approval := verify_editor_approval(p_outlet_id, p_editor_username, p_editor_password);
  if v_approval ? 'error' then
    return jsonb_build_object('ok', false, 'error', v_approval->>'error');
  end if;

  update orders
     set status = 'cancelled'
        --  , cancel_reason = p_reason,
        --  cancelled_by = auth.uid(),
        --  cancelled_at = now()
   where id = p_order_id
   returning table_id into v_table_id;

  if v_table_id is not null and not exists (
    select 1 from orders
    where table_id = v_table_id
      and status not in ('completed', 'cancelled')
  ) then
    update tables set state = 'open' where id = v_table_id;
  end if;

  select jsonb_build_object(
           'order_number', o.order_number, 'invoice_number', o.invoice_number,
           'table_id', o.table_id, 'order_type', o.order_type,
           'status', o.status, 'total_amount', o.total_amount,
           'approved_by', v_approval->>'editor_email',
           'approved_by_id', v_approval->>'editor_id')
    into v_order
  from orders o where o.id = p_order_id;

  insert into app_activity_log
    (order_id, order_item_id, old_quantity, new_quantity, changed_by, changed_at,
     created_at, order_details, reason, activity)
  values (
    p_order_id, null, null, null,
    auth.uid(), now(), now(), v_order::json, trim(p_reason), 'order.cancelled'
  );
   return jsonb_build_object('ok', true);
end;
$$;

grant execute on function cancel_order(uuid, uuid, text, text, text) to authenticated;
