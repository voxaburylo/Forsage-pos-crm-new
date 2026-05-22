-- ============================================================
-- E-0: get_available_qty(product_id) + v_product_stock alias
-- ============================================================

-- 1. Функція для inline-використання в інших RPC (process_sale_v2 тощо)
--    Повертає qty_available = qty_on_hand - активні резерви для product_id
CREATE OR REPLACE FUNCTION get_available_qty(p_product_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_qty_on_hand  NUMERIC := 0;
    v_qty_reserved NUMERIC := 0;
BEGIN
    SELECT qty_on_hand INTO v_qty_on_hand
    FROM products
    WHERE id = p_product_id AND deleted_at IS NULL;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    SELECT COALESCE(SUM(qty), 0) INTO v_qty_reserved
    FROM inventory_reserves
    WHERE product_id = p_product_id
      AND released_at IS NULL
      AND (expires_at IS NULL OR expires_at > now());

    RETURN GREATEST(0, v_qty_on_hand - v_qty_reserved);
END;
$$;

-- 2. Alias-view v_product_stock → сумісність із ROADMAP-специфікацією
--    (products_available вже існує і використовується, цей view дублює її структуру)
CREATE OR REPLACE VIEW v_product_stock AS
SELECT
    p.id            AS product_id,
    p.qty_on_hand,
    COALESCE(SUM(r.qty) FILTER (
        WHERE r.released_at IS NULL
          AND (r.expires_at IS NULL OR r.expires_at > now())
    ), 0)           AS qty_reserved,
    GREATEST(0,
        p.qty_on_hand - COALESCE(SUM(r.qty) FILTER (
            WHERE r.released_at IS NULL
              AND (r.expires_at IS NULL OR r.expires_at > now())
        ), 0)
    )               AS qty_available
FROM products p
LEFT JOIN inventory_reserves r ON r.product_id = p.id
WHERE p.deleted_at IS NULL
GROUP BY p.id, p.qty_on_hand;
