-- 098_audit_remediations.sql
-- Ремедіація вразливостей та багів, виявлених при аудиті:
--   1. Дробна кількість у return_items (підтримка весового товару)
--   2. Атомарний повернення process_return підтримує дробну кількість
--   3. Функція upsert_product_import підтримує p_category_id
--   4. RLS на таблиці idempotency_keys та sys_background_jobs

-- ============================================================
-- 1. Дробна кількість у return_items
-- ============================================================
ALTER TABLE return_items ALTER COLUMN quantity TYPE NUMERIC(12,3);

-- ============================================================
-- 2. Оновлена функція process_return (дробний qty)
-- ============================================================
CREATE OR REPLACE FUNCTION process_return(
    p_tenant_id         UUID,
    p_user_id           UUID,
    p_sale_id           UUID,
    p_reason            VARCHAR(50),
    p_refund_method     VARCHAR(20),
    p_items             JSONB,
    p_customer_id       UUID DEFAULT NULL,
    p_reason_note       TEXT DEFAULT NULL,
    p_stock_action      VARCHAR(20) DEFAULT 'return_to_stock'
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $BODY$
DECLARE
    v_return_id         UUID;
    v_item              JSONB;
    v_sale_item_id      UUID;
    v_product_id        UUID;
    v_requested_product UUID;
    v_requested_qty     NUMERIC(12,3);
    v_unit_price        INTEGER;
    v_total_refund      INTEGER := 0;
    v_already_returned  NUMERIC(12,3);
    v_orig_qty          NUMERIC(12,3);
    v_sale_status       VARCHAR(20);
    v_sale_customer_id  UUID;
    v_restricted_count  BIGINT;
    v_woff_id           UUID;
    v_full_count        BIGINT;
    v_total_items       BIGINT;
    v_sale_number       VARCHAR(20);
BEGIN
    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'INVALID_RETURN_ITEMS';
    END IF;
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_items) AS e(item)
        GROUP BY e.item->>'sale_item_id' HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'DUPLICATE_ITEM';
    END IF;

    SELECT s.status, s.sale_number, s.customer_id
      INTO v_sale_status, v_sale_number, v_sale_customer_id
    FROM sales s
    WHERE s.id = p_sale_id AND s.tenant_id = p_tenant_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'SALE_NOT_FOUND';
    END IF;

    IF v_sale_status = 'returned' THEN
        RAISE EXCEPTION 'ALREADY_RETURNED';
    END IF;

    IF p_customer_id IS NOT NULL AND p_customer_id IS DISTINCT FROM v_sale_customer_id THEN
        RAISE EXCEPTION 'CUSTOMER_MISMATCH';
    END IF;
    SELECT COUNT(*) INTO v_restricted_count
    FROM jsonb_array_elements(p_items) AS j(item)
    JOIN sale_items si
      ON si.id = (j.item->>'sale_item_id')::UUID
     AND si.sale_id = p_sale_id
     AND si.tenant_id = p_tenant_id
    JOIN products p ON p.id = si.product_id AND p.tenant_id = p_tenant_id
    JOIN categories c
      ON c.id = p.category_id AND c.tenant_id = p_tenant_id AND c.name = 'Електроніка';

    IF v_restricted_count > 0 THEN
        RAISE EXCEPTION 'CATEGORY_RESTRICTED';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        BEGIN
            v_sale_item_id := (v_item->>'sale_item_id')::UUID;
            v_requested_qty := (v_item->>'quantity')::NUMERIC(12,3);
            v_requested_product := CASE
                WHEN NULLIF(v_item->>'product_id', '') IS NULL THEN NULL
                ELSE (v_item->>'product_id')::UUID
            END;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            RAISE EXCEPTION 'INVALID_RETURN_ITEMS';
        END;
        IF v_requested_qty IS NULL OR v_requested_qty <= 0 THEN
            RAISE EXCEPTION 'INVALID_RETURN_ITEMS';
        END IF;

        SELECT si.product_id, si.unit_price, si.qty
          INTO v_product_id, v_unit_price, v_orig_qty
        FROM sale_items si
        JOIN products p ON p.id = si.product_id AND p.tenant_id = p_tenant_id
        WHERE si.id = v_sale_item_id
          AND si.sale_id = p_sale_id
          AND si.tenant_id = p_tenant_id
        FOR UPDATE OF si;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'ITEM_NOT_FOUND';
        END IF;
        IF v_requested_product IS NOT NULL AND v_requested_product <> v_product_id THEN
            RAISE EXCEPTION 'PRODUCT_MISMATCH';
        END IF;

        SELECT COALESCE(SUM(ri.quantity), 0)::NUMERIC(12,3) INTO v_already_returned
        FROM return_items ri
        WHERE ri.sale_item_id = v_sale_item_id AND ri.tenant_id = p_tenant_id;

        IF v_requested_qty > GREATEST(0, v_orig_qty - v_already_returned) THEN
            RAISE EXCEPTION 'DUPLICATE_RETURN';
        END IF;

        v_total_refund := v_total_refund + ROUND(v_unit_price * v_requested_qty)::INTEGER;
    END LOOP;

    INSERT INTO returns (
        tenant_id, sale_id, customer_id, return_type,
        reason, reason_note, refund_method, refund_kopecks,
        refund_amount, stock_action, status, created_by, approved_by
    ) VALUES (
        p_tenant_id, p_sale_id, v_sale_customer_id, 'refund',
        p_reason, p_reason_note, p_refund_method, v_total_refund,
        v_total_refund, p_stock_action, 'completed', p_user_id, p_user_id
    ) RETURNING id INTO v_return_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        v_sale_item_id := (v_item->>'sale_item_id')::UUID;
        v_requested_qty := (v_item->>'quantity')::NUMERIC(12,3);
        SELECT si.product_id, si.unit_price INTO v_product_id, v_unit_price
        FROM sale_items si
        JOIN products p ON p.id = si.product_id AND p.tenant_id = p_tenant_id
        WHERE si.id = v_sale_item_id
          AND si.sale_id = p_sale_id
          AND si.tenant_id = p_tenant_id;

        INSERT INTO return_items (
            tenant_id, return_id, product_id, sale_item_id,
            quantity, unit_price_kopecks, total_kopecks, condition
        ) VALUES (
            p_tenant_id, v_return_id, v_product_id, v_sale_item_id,
            v_requested_qty, v_unit_price,
            ROUND(v_unit_price * v_requested_qty)::INTEGER,
            COALESCE(v_item->>'condition', 'good')
        );

        IF p_stock_action = 'return_to_stock' THEN
            UPDATE products SET
                qty_on_hand = qty_on_hand + v_requested_qty,
                updated_at = NOW()
            WHERE id = v_product_id AND tenant_id = p_tenant_id;
        END IF;
    END LOOP;

    IF p_stock_action = 'write_off' THEN
        INSERT INTO inventory_writeoffs (tenant_id, reason, notes, created_by)
        VALUES (
            p_tenant_id, 'damage',
            'Списання при поверненні, чек #' || v_sale_number,
            p_user_id
        )
        RETURNING id INTO v_woff_id;

        INSERT INTO inventory_writeoff_items (writeoff_id, product_id, qty)
        SELECT v_woff_id, si.product_id, (e.item->>'quantity')::NUMERIC(12,3)
        FROM jsonb_array_elements(p_items) AS e(item)
        JOIN sale_items si
          ON si.id = (e.item->>'sale_item_id')::UUID
         AND si.sale_id = p_sale_id
         AND si.tenant_id = p_tenant_id
        JOIN products p
          ON p.id = si.product_id AND p.tenant_id = p_tenant_id;
    END IF;

    IF p_refund_method = 'debt_reduction' AND v_sale_customer_id IS NOT NULL THEN
        UPDATE customers SET
            debt_balance = GREATEST(0, debt_balance - v_total_refund),
            updated_at = NOW()
        WHERE id = v_sale_customer_id AND tenant_id = p_tenant_id;
    END IF;

    SELECT COUNT(*) INTO v_total_items
    FROM sale_items WHERE sale_id = p_sale_id AND tenant_id = p_tenant_id;

    SELECT COUNT(*) INTO v_full_count FROM (
        SELECT si.id
        FROM sale_items si
        LEFT JOIN return_items ri
          ON ri.sale_item_id = si.id AND ri.tenant_id = p_tenant_id
        WHERE si.sale_id = p_sale_id
          AND si.tenant_id = p_tenant_id
        GROUP BY si.id, si.qty
        HAVING COALESCE(SUM(ri.quantity), 0) >= si.qty
    ) fully;

    IF v_total_items > 0 AND v_full_count >= v_total_items THEN
        UPDATE sales SET status = 'returned', updated_at = NOW()
        WHERE id = p_sale_id AND tenant_id = p_tenant_id;
    END IF;

    RETURN (SELECT row_to_json(r)::jsonb FROM (
        SELECT * FROM returns WHERE id = v_return_id AND tenant_id = p_tenant_id
    ) r);
END;
$BODY$;

-- ============================================================
-- 3. Оновлена функція upsert_product_import (з category_id)
-- ============================================================
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
    p_mode            VARCHAR,
    p_category_id     UUID DEFAULT NULL
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
    SELECT id, qty_on_hand INTO v_product_id, v_existing_qty
    FROM products
    WHERE tenant_id = p_tenant_id AND sku = p_sku AND deleted_at IS NULL
    LIMIT 1
    FOR UPDATE;

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
            category_id    = COALESCE(p_category_id, category_id),
            updated_at     = NOW()
        WHERE id = v_product_id;
    ELSE
        v_is_new := true;
        INSERT INTO products (tenant_id, sku, name, barcode, retail_price, purchase_price, qty_on_hand, unit, storage_bin, category_id)
        VALUES (p_tenant_id, p_sku, p_name, p_barcode, p_retail_price, p_purchase_price, p_qty_on_hand, p_unit, p_storage_bin, p_category_id)
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

-- ============================================================
-- 4. RLS на таблиці idempotency_keys та sys_background_jobs
-- ============================================================
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "idempotency_keys_all" ON idempotency_keys;
CREATE POLICY "idempotency_keys_all" ON idempotency_keys
  FOR ALL USING (tenant_id = app.user_tenant_id());

ALTER TABLE sys_background_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sys_background_jobs_all" ON sys_background_jobs;
CREATE POLICY "sys_background_jobs_all" ON sys_background_jobs
  FOR ALL USING (tenant_id = app.user_tenant_id());

NOTIFY pgrst, 'reload schema';