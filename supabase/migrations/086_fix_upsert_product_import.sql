-- Improvement#4: upsert_product_import — шукаємо спочатку по SKU, потім по barcode
-- Уникаємо недетермінованого LIMIT 1 при OR-пошуку

CREATE OR REPLACE FUNCTION upsert_product_import(
    p_tenant_id       UUID,
    p_sku             VARCHAR,
    p_barcode         VARCHAR,
    p_name            VARCHAR,
    p_retail_price    INTEGER,
    p_purchase_price  INTEGER,
    p_qty_on_hand     NUMERIC,
    p_unit            VARCHAR,
    p_storage_bin     VARCHAR,
    p_mode            VARCHAR
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
    v_product_id      UUID;
    v_existing_qty    NUMERIC;
    v_new_qty         NUMERIC;
    v_is_new          BOOLEAN := false;
BEGIN
    -- 1. Спочатку шукаємо по SKU
    SELECT id, qty_on_hand INTO v_product_id, v_existing_qty
    FROM products
    WHERE tenant_id = p_tenant_id AND sku = p_sku AND deleted_at IS NULL
    LIMIT 1
    FOR UPDATE;

    -- 2. Якщо по SKU не знайдено — шукаємо по barcode
    IF NOT FOUND AND p_barcode IS NOT NULL THEN
        SELECT id, qty_on_hand INTO v_product_id, v_existing_qty
        FROM products
        WHERE tenant_id = p_tenant_id AND barcode = p_barcode AND deleted_at IS NULL
        LIMIT 1
        FOR UPDATE;
    END IF;

    IF FOUND THEN
        IF p_mode = 'add' THEN
            v_new_qty := v_existing_qty + p_qty_on_hand;
        ELSE
            v_new_qty := p_qty_on_hand;
        END IF;

        UPDATE products
        SET name           = p_name,
            retail_price   = p_retail_price,
            purchase_price = p_purchase_price,
            qty_on_hand    = v_new_qty,
            unit           = p_unit,
            storage_bin    = p_storage_bin,
            updated_at     = NOW()
        WHERE id = v_product_id;
    ELSE
        v_is_new := true;
        INSERT INTO products (tenant_id, sku, name, barcode, retail_price, purchase_price, qty_on_hand, unit, storage_bin)
        VALUES (p_tenant_id, p_sku, p_name, p_barcode, p_retail_price, p_purchase_price, p_qty_on_hand, p_unit, p_storage_bin)
        RETURNING id INTO v_product_id;
    END IF;

    RETURN jsonb_build_object(
        'id',      v_product_id,
        'is_new',  v_is_new,
        'old_qty', COALESCE(v_existing_qty, 0),
        'new_qty', COALESCE(v_new_qty, p_qty_on_hand)
    );
END;
$$;
