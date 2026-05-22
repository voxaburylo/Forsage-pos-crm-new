-- 025_extended_business_logic.sql
-- Склад: адреса зберігання, менеджер підбору, ячейка замовлення

-- ============================================================
-- 1. Додаємо storage_bin до products (Стелаж/Полиця)
-- ============================================================
ALTER TABLE products ADD COLUMN IF NOT EXISTS storage_bin VARCHAR(50);

-- ============================================================
-- 2. Додаємо manager_id до sales (хто підбирав запчастини)
-- ============================================================
ALTER TABLE sales ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES users(id);

-- ============================================================
-- 3. Додаємо pickup_cell до orders (ячейка зібраного замовлення)
-- ============================================================
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_cell VARCHAR(50);

-- ============================================================
-- 4. Оновлюємо process_sale: приймає p_manager_id
-- ============================================================
CREATE OR REPLACE FUNCTION process_sale(
    p_tenant_id         UUID,
    p_cashier_id        UUID,
    p_shift_id          UUID,
    p_items             JSONB,
    p_payment_method    VARCHAR(20),
    p_customer_id       UUID DEFAULT NULL,
    p_discount          INTEGER DEFAULT 0,
    p_notes             TEXT DEFAULT NULL,
    p_manager_id        UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $_$
DECLARE
    v_sale_id       UUID;
    v_sale_number   VARCHAR(20);
    v_subtotal      INTEGER := 0;
    v_total         INTEGER := 0;
    v_item          JSONB;
    v_unit_price    INTEGER;
    v_qty           NUMERIC;
    v_item_discount INTEGER;
    v_current_qty   NUMERIC;
    v_settings      JSONB;
    v_allow_neg     BOOLEAN;
BEGIN
    SELECT row_to_json(ss.*)::jsonb INTO v_settings
    FROM shop_settings ss WHERE ss.tenant_id = p_tenant_id LIMIT 1;
    IF v_settings IS NULL THEN v_allow_neg := true;
    ELSE v_allow_neg := (v_settings->>'allow_negative_qty')::boolean; END IF;

    v_sale_number := LPAD(nextval('sale_number_seq')::TEXT, 6, '0');

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        v_unit_price := (v_item->>'unit_price')::INTEGER;
        v_qty := (v_item->>'qty')::NUMERIC;
        v_item_discount := COALESCE((v_item->>'discount')::INTEGER, 0);
        v_subtotal := v_subtotal + (v_unit_price * v_qty::INTEGER);

        SELECT qty_on_hand INTO v_current_qty FROM products
        WHERE id = (v_item->>'product_id')::UUID AND deleted_at IS NULL
        FOR UPDATE;

        IF NOT FOUND THEN RAISE EXCEPTION 'Товар % не знайдено', (v_item->>'product_id')::TEXT; END IF;
        IF v_current_qty < v_qty AND NOT v_allow_neg THEN RAISE EXCEPTION 'INSUFFICIENT_STOCK'; END IF;
    END LOOP;

    v_total := GREATEST(0, v_subtotal - p_discount);

    INSERT INTO sales (tenant_id,sale_number,customer_id,cashier_id,shift_id,status,subtotal,discount,total,payment_method,is_debt,notes,manager_id)
    VALUES (p_tenant_id,v_sale_number,p_customer_id,p_cashier_id,p_shift_id,'completed',v_subtotal,p_discount,v_total,p_payment_method,p_payment_method='debt',p_notes,p_manager_id)
    RETURNING id INTO v_sale_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        v_unit_price := (v_item->>'unit_price')::INTEGER;
        v_qty := (v_item->>'qty')::NUMERIC;
        v_item_discount := COALESCE((v_item->>'discount')::INTEGER, 0);
        INSERT INTO sale_items (tenant_id,sale_id,product_id,qty,unit_price,discount,total)
        VALUES (p_tenant_id,v_sale_id,(v_item->>'product_id')::UUID,v_qty,v_unit_price,v_item_discount,v_unit_price*v_qty::INTEGER-v_item_discount);
        UPDATE products SET qty_on_hand = qty_on_hand - v_qty, updated_at = NOW()
        WHERE id = (v_item->>'product_id')::UUID;
    END LOOP;

    IF p_payment_method = 'debt' AND p_customer_id IS NOT NULL THEN
        UPDATE customers
        SET debt_balance = debt_balance + v_total, updated_at = NOW()
        WHERE id = p_customer_id;
    END IF;

    RETURN (SELECT row_to_json(s)::jsonb FROM (SELECT * FROM sales WHERE id = v_sale_id) s);
END;
$_$;
