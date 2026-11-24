-- Категорія товару постачальника (рішення власника 24.11.2026): товари Омеги розкладаються по НАШИХ категоріях
-- автоматично — за типом товару в назві, навченим на наших картках. Що автоматично не розклалось — без категорії:
-- власник розкладе сам (вручну чи через ШІ-помічника). category_source: 'auto' — поставила програма (може уточнити
-- при наступному завантаженні), 'manual' — поставила людина (програма більше не чіпає).
ALTER TABLE public.supplier_offers ADD COLUMN IF NOT EXISTS category_id uuid;
ALTER TABLE public.supplier_offers ADD COLUMN IF NOT EXISTS category_source text CHECK (category_source IS NULL OR category_source IN ('auto', 'manual'));
CREATE INDEX IF NOT EXISTS idx_supplier_offers_category ON public.supplier_offers (tenant_id, category_id);

CREATE OR REPLACE VIEW public.site_supplier_offers AS
SELECT o.tenant_id, o.connection_id, o.external_id, o.number, o.brand, o.name, o.barcode, o.image_url, o.product_id,
       o.retail_price, o.total_qty AS supplier_qty,
       (SELECT min(w.days_to_ship) FROM jsonb_array_elements(o.stock) s
          JOIN public.supplier_warehouses w ON w.connection_id = o.connection_id AND w.code = s->>'w' AND w.is_active
         WHERE (s->>'q')::int > 0) AS min_days_to_ship,
       o.updated_at,
       o.category_id
  FROM public.supplier_offers o
  JOIN public.supplier_api_connections c ON c.id = o.connection_id AND c.enabled
 WHERE o.total_qty > 0;
REVOKE ALL ON public.site_supplier_offers FROM PUBLIC, anon, authenticated;
