-- ============================================================
-- Форсаж CRM — KPI цілі для персоналу
-- Міграція 071: staff_kpi_targets + RPC розрахунку KPI
-- ============================================================

-- 1. Таблиця цільових показників KPI
CREATE TABLE IF NOT EXISTS staff_kpi_targets (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
    user_id       UUID NOT NULL REFERENCES auth.users(id),
    period        VARCHAR(7) NOT NULL, -- формат 'YYYY-MM' (наприклад '2026-05')
    metric_type   VARCHAR(50) NOT NULL, -- 'sales_revenue', 'sales_count', 'orders_count', 'avg_check'
    target_value  NUMERIC(14,2) NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, user_id, period, metric_type)
);

-- Індекси
CREATE INDEX idx_staff_kpi_targets_lookup ON staff_kpi_targets(tenant_id, user_id, period);

-- RLS
ALTER TABLE staff_kpi_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff_kpi_targets_all" ON staff_kpi_targets FOR ALL USING (true);

-- 2. RPC: розрахунок факту KPI за період
CREATE OR REPLACE FUNCTION calculate_kpi(
    p_tenant_id UUID,
    p_user_id   UUID,
    p_period    VARCHAR -- 'YYYY-MM'
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_from       TIMESTAMPTZ;
    v_to         TIMESTAMPTZ;
    v_sales_rev  NUMERIC := 0;
    v_sales_cnt  INTEGER := 0;
    v_orders_cnt INTEGER := 0;
    v_avg_check  NUMERIC := 0;
    v_targets    JSONB;
BEGIN
    -- Обчислюємо діапазон дат з рядка 'YYYY-MM'
    v_from := (p_period || '-01')::DATE;
    v_to   := (v_from + INTERVAL '1 month');

    -- Факт продажів (POS)
    SELECT COALESCE(COUNT(*), 0), COALESCE(SUM(total), 0)
    INTO v_sales_cnt, v_sales_rev
    FROM sales
    WHERE tenant_id = p_tenant_id
      AND manager_id = p_user_id
      AND status = 'completed'
      AND completed_at >= v_from
      AND completed_at < v_to;

    -- Факт замовлень
    SELECT COALESCE(COUNT(*), 0)
    INTO v_orders_cnt
    FROM customer_orders
    WHERE tenant_id = p_tenant_id
      AND manager_id = p_user_id
      AND status IN ('completed', 'ready', 'in_progress')
      AND created_at >= v_from
      AND created_at < v_to;

    -- Середній чек
    IF v_sales_cnt > 0 THEN
        v_avg_check := ROUND(v_sales_rev / v_sales_cnt, 2);
    END IF;

    -- Цілі за цей період
    SELECT COALESCE(jsonb_object_agg(metric_type, target_value), '{}'::JSONB)
    INTO v_targets
    FROM staff_kpi_targets
    WHERE tenant_id = p_tenant_id
      AND user_id = p_user_id
      AND period = p_period;

    RETURN jsonb_build_object(
        'user_id', p_user_id,
        'period', p_period,
        'fact', jsonb_build_object(
            'sales_revenue', v_sales_rev,
            'sales_count', v_sales_cnt,
            'orders_count', v_orders_cnt,
            'avg_check', v_avg_check
        ),
        'targets', v_targets
    );
END;
$$;
