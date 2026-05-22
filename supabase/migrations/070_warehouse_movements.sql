-- ============================================================
-- Форсаж CRM — Переміщення товарів між комірками
-- Міграція 070: warehouse_movements + RPC
-- ============================================================

-- 1. Таблиця переміщень
CREATE TABLE IF NOT EXISTS warehouse_movements (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
    product_id  UUID NOT NULL REFERENCES products(id),
    from_bin    VARCHAR(100),
    to_bin      VARCHAR(100) NOT NULL,
    qty         NUMERIC(12,3) NOT NULL CHECK (qty > 0),
    moved_by    UUID REFERENCES auth.users(id),
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Індекси
CREATE INDEX idx_warehouse_movements_tenant ON warehouse_movements(tenant_id, created_at DESC);
CREATE INDEX idx_warehouse_movements_product ON warehouse_movements(product_id);

-- RLS
ALTER TABLE warehouse_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "warehouse_movements_all" ON warehouse_movements FOR ALL USING (true);

-- 2. RPC: атомарне переміщення товару між комірками
CREATE OR REPLACE FUNCTION process_warehouse_movement(
    p_tenant_id   UUID,
    p_product_id  UUID,
    p_qty         NUMERIC,
    p_from_bin    VARCHAR,
    p_to_bin      VARCHAR,
    p_moved_by    UUID,
    p_note        TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
    v_product_name VARCHAR;
    v_current_bin  VARCHAR;
    v_movement_id  UUID;
BEGIN
    -- Блокуємо рядок товару
    SELECT name, storage_bin INTO v_product_name, v_current_bin
    FROM products
    WHERE id = p_product_id
      AND tenant_id = p_tenant_id
      AND deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND: Товар з ID % не знайдено', p_product_id;
    END IF;

    -- Оновлюємо storage_bin на нове розташування
    UPDATE products
    SET storage_bin = p_to_bin,
        updated_at = now()
    WHERE id = p_product_id
      AND tenant_id = p_tenant_id;

    -- Створюємо запис переміщення
    INSERT INTO warehouse_movements (tenant_id, product_id, from_bin, to_bin, qty, moved_by, note)
    VALUES (p_tenant_id, p_product_id, COALESCE(p_from_bin, v_current_bin), p_to_bin, p_qty, p_moved_by, p_note)
    RETURNING id INTO v_movement_id;

    -- Записуємо в audit_log
    INSERT INTO audit_log (tenant_id, user_id, user_name, action, entity_type, entity_id, entity_label, old_value, new_value)
    VALUES (
        p_tenant_id,
        p_moved_by,
        'movement',
        'warehouse_movement',
        'products',
        p_product_id::TEXT,
        v_product_name,
        jsonb_build_object('storage_bin', COALESCE(p_from_bin, v_current_bin)),
        jsonb_build_object('storage_bin', p_to_bin, 'qty', p_qty)
    );

    RETURN jsonb_build_object(
        'movement_id', v_movement_id,
        'product_name', v_product_name,
        'from_bin', COALESCE(p_from_bin, v_current_bin),
        'to_bin', p_to_bin,
        'qty', p_qty
    );
END;
$$;
