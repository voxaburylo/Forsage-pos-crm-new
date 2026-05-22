-- ============================================================
-- E-15: Auto-Purchasing — автоматичні закупки за reorder_point
-- ============================================================

-- 1. Правила автозакупки
CREATE TABLE IF NOT EXISTS auto_purchase_rules (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
    product_id   UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    supplier_id  UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    min_qty      NUMERIC(12,3) NOT NULL DEFAULT 1,
    max_qty      NUMERIC(12,3) NOT NULL DEFAULT 100,
    is_active    BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, product_id)
);

CREATE INDEX idx_auto_purchase_rules_tenant ON auto_purchase_rules(tenant_id, is_active);

ALTER TABLE auto_purchase_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auto_purchase_rules_all" ON auto_purchase_rules FOR ALL USING (true);

-- 2. RPC: генерація пропозицій закупки
--    Шукає товари де qty_on_hand < reorder_point
CREATE OR REPLACE FUNCTION generate_purchase_suggestions(p_tenant_id UUID)
RETURNS TABLE(
    product_id       UUID,
    product_name     VARCHAR,
    sku              VARCHAR,
    qty_on_hand      NUMERIC,
    reorder_point    NUMERIC,
    suggest_qty      NUMERIC,
    supplier_id      UUID,
    supplier_name    VARCHAR,
    rule_id          UUID
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        p.id                                          AS product_id,
        p.name                                        AS product_name,
        p.sku,
        p.qty_on_hand,
        p.reorder_point,
        GREATEST(r.min_qty, p.reorder_point - p.qty_on_hand + r.min_qty) AS suggest_qty,
        r.supplier_id,
        s.name                                        AS supplier_name,
        r.id                                          AS rule_id
    FROM products p
    JOIN auto_purchase_rules r ON r.product_id = p.id AND r.tenant_id = p_tenant_id AND r.is_active = true
    LEFT JOIN suppliers s ON s.id = r.supplier_id
    WHERE p.tenant_id = p_tenant_id
      AND p.deleted_at IS NULL
      AND p.qty_on_hand < p.reorder_point
    ORDER BY (p.reorder_point - p.qty_on_hand) DESC;
END;
$$;
