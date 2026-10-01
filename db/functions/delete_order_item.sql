-- delete_order_item(): soft delete only — never removes the row. Same audit,
-- 'open'-only restriction, and totals recompute as edit_order_item.
-- ---------------------------------------------------------------------------
drop function if exists delete_order_item(uuid, text);
drop function if exists delete_order_item(uuid, uuid, text);

-- Same outlet-parameter / mandatory-reason / dual-audit-write rules as
-- edit_order_item above.
create or replace function delete_order_item(
  p_outlet_id uuid,
  p_order_item_id uuid,
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
    raise exception 'A reason is required to remove an order item';
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
    and o.status = 'open';

  if v_order_id is null then
    raise exception 'Not authorized, item not found, or the order is not editable in its current status';
  end if;

  -- Second factor — see edit_order_item / verify_editor_approval.
  v_approval := verify_editor_approval(p_outlet_id, p_editor_username, p_editor_password);
  if v_approval ? 'error' then
    return jsonb_build_object('ok', false, 'error', v_approval->>'error');
  end if;

  update order_items
     set is_deleted = true,
         edited_at = now(),
         edited_by = auth.uid()
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

  -- new_quantity is null for a delete: the line no longer contributes.
  insert into app_activity_log
    (order_id, order_item_id, old_quantity, new_quantity, changed_by, changed_at,
     created_at, order_details, reason, activity)
  values (
    v_order_id, p_order_item_id,
    (v_old->>'quantity')::numeric, null,
    auth.uid(), now(), now(), v_order::json, trim(p_reason), 'order.item.delete'
  );

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function delete_order_item(uuid, uuid, text, text, text) to authenticated;