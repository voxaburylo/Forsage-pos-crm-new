-- 26.11.2026: «Сайт → Усі товари» — наші й товари постачальників в одному списку. Без індексів пошук по 79 тис.
-- товарів постачальника читав усю таблицю (~5,6 с). Лише нові індекси; дані не змінюються.
CREATE INDEX IF NOT EXISTS idx_supplier_offers_search_trgm ON public.supplier_offers
  USING gin ((lower(COALESCE(custom_name, name) || ' ' || COALESCE(number, '') || ' ' || COALESCE(custom_barcode, barcode, ''))) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_supplier_offers_tenant_name ON public.supplier_offers (tenant_id, lower(COALESCE(custom_name, name)), external_id);
CREATE INDEX IF NOT EXISTS idx_products_tenant_lower_name ON public.products (tenant_id, lower(name), id) WHERE deleted_at IS NULL;
