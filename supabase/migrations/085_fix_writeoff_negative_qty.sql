-- Bug#2: process_writeoff тепер перевіряє allow_negative_qty
-- Консистентно з process_internal_consumption

CREATE OR REPLACE FUNCTION process_writeoff(
    p_tenant_id     UUID,
    p_reason        VARCHAR,
    p_notes         TEXT,
    p_created_by    UUID,
    p_items         JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
    v_writeoff_id   UUID;
    v_item          JSONB;
    v_product_id    UUID;
    v_qty           NUMERIC;
    v_current_qty   NUMERIC;
    v_name          VARCHAR;
    v_price         INTEGER;
    v_allow_neg     BOOLEAN;
BEGIN
    -- Отримуємо налаштування allow_negative_qty
    SELECT COALESCE(allow_negative_qty, true) INTO v_allow_neg
    FROM shop_settings WHERE tenant_id = p_tenant_id LIMIT 1;
    IF NOT FOUND THEN v_allow_neg := true; END IF;

    -- Перевіряємо залишки з блокуванням рядків
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        v_product_id := (v_item->>'product_id')::UUID;
        v_qty        := (v_item->>'qty')::NUMERIC;

        SELECT qty_on_hand, name INTO v_current_qty, v_name FROM products
        WHERE id = v_product_id AND deleted_at IS NULL
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'PRODUCT_NOT_FOUND: Товар не знайдено: %', v_product_id;
        END IF;

        IF v_current_qty < v_qty AND NOT v_allow_neg THEN
            RAISE EXCEPTION 'INSUFFICIENT_STOCK: Недостатньо залишку для "%": є %, потрібно %', v_name, v_current_qty, v_qty;
        END IF;
    END LOOP;

    -- Створюємо акт списання
    INSERT INTO inventory_writeoffs (tenant_id, reason, notes, created_by)
    VALUES (p_tenant_id, p_reason::VARCHAR(50), p_notes, p_created_by)
    RETURNING id INTO v_writeoff_id;

    -- Вставляємо позиції та оновлюємо залишки
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        v_product_id := (v_item->>'product_id')::UUID;
        v_qty        := (v_item->>'qty')::NUMERIC;

        SELECT purchase_price INTO v_price FROM products WHERE id = v_product_id;

        INSERT INTO inventory_writeoff_items (writeoff_id, product_id, qty, cost_kopecks)
        VALUES (v_writeoff_id, v_product_id, v_qty, ROUND(v_price * v_qty)::INTEGER);

        UPDATE products
        SET qty_on_hand = qty_on_hand - v_qty,
            updated_at  = NOW()
        WHERE id = v_product_id;
    END LOOP;

    RETURN (SELECT row_to_json(w)::jsonb FROM (SELECT * FROM inventory_writeoffs WHERE id = v_writeoff_id) w);
END;
$$;
