-- ============================================================
-- Форсаж CRM — Захист від від'ємних залишків (DB-level)
-- Міграція 069: тригер на products + RPC перевірки цілісності
-- ============================================================

-- 1. Тригерна функція: блокує UPDATE qty_on_hand < 0
--    якщо allow_negative_qty = false для tenant_id товару
CREATE OR REPLACE FUNCTION fn_prevent_negative_qty()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_allow_neg BOOLEAN;
BEGIN
    -- Перевіряємо тільки якщо qty_on_hand реально змінився
    IF NEW.qty_on_hand IS NOT DISTINCT FROM OLD.qty_on_hand THEN
        RETURN NEW;
    END IF;

    -- Якщо нове значення >= 0, завжди дозволяємо
    IF NEW.qty_on_hand >= 0 THEN
        RETURN NEW;
    END IF;

    -- Значення < 0, перевіряємо налаштування tenant
    SELECT allow_negative_qty INTO v_allow_neg
    FROM shop_settings
    WHERE tenant_id = NEW.tenant_id
    LIMIT 1;

    -- Якщо налаштування не знайдено — дозволяємо (backward compatibility)
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    -- Якщо дозволено — пропускаємо
    IF v_allow_neg = true THEN
        RETURN NEW;
    END IF;

    -- Заборонено: блокуємо операцію
    RAISE EXCEPTION 'NEGATIVE_STOCK_BLOCKED: Заборонено від''ємний залишок для товару "%" (ID: %). Спроба встановити qty_on_hand = %',
        NEW.name, NEW.id, NEW.qty_on_hand;

    RETURN NULL; -- Недосяжний код, але для повноти
END;
$$;

-- 2. Тригер BEFORE UPDATE на products
DROP TRIGGER IF EXISTS trg_prevent_negative_qty ON products;
CREATE TRIGGER trg_prevent_negative_qty
    BEFORE UPDATE OF qty_on_hand ON products
    FOR EACH ROW
    EXECUTE FUNCTION fn_prevent_negative_qty();

-- 3. RPC для перевірки цілісності залишків
--    Повертає товари з від'ємним qty_on_hand
CREATE OR REPLACE FUNCTION validate_stock_integrity(p_tenant_id UUID)
RETURNS TABLE(
    product_id UUID,
    product_name VARCHAR,
    sku VARCHAR,
    qty_on_hand NUMERIC,
    storage_bin VARCHAR,
    updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        p.id AS product_id,
        p.name AS product_name,
        p.sku,
        p.qty_on_hand,
        p.storage_bin,
        p.updated_at
    FROM products p
    WHERE p.tenant_id = p_tenant_id
      AND p.deleted_at IS NULL
      AND p.qty_on_hand < 0
    ORDER BY p.qty_on_hand ASC;
END;
$$;
