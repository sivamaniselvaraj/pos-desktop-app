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

    if v_order_type = 'pickup' or v_order_type = 'takeaway' then
        select coalesce(sum(oi.quantity * oi.unit_price * coalesce(mi.container_charge / 100, 0)), 0)
        into v_container_charge
        from order_items oi
        join menu_items mi on mi.id = oi.menu_item_id 
        where oi.order_id = p_order_id and not oi.is_deleted;
    end if;

    v_tax := round((v_subtotal + v_container_charge) * 0.05, 2);

    update orders
        set subtotal = v_subtotal,
            tax_amount = v_tax,
            container_amount = round(v_container_charge, 2),
            total_amount = v_subtotal + v_tax + v_container_charge
    where id = p_order_id;
    end;
    $$;

    revoke execute on function recompute_order_totals(uuid) from public;
