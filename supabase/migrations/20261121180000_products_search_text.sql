-- 21.11.2026 (план швидкості вебу, пакет 2): пошук товарів перевіряв ~16 800 карток по 7 полях кожну
-- (EXPLAIN ANALYZE запиту «2108»: 1,47 с). Тепер одна пошукова колонка з trigram-індексом відбирає
-- кандидатів, а точні умови пошуку перевіряються лише на них — результат той самий, лише швидше.
-- Колонку заповнює тригер (а не GENERATED), щоб будь-який наявний запис чи upsert з повним рядком
-- товару не впав на «cannot insert a non-DEFAULT value». Дані товарів не змінюються.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS search_text text;

CREATE OR REPLACE FUNCTION public.products_search_text(p public.products)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p.name, '') || ' ' || coalesce(p.sku, '') || ' ' || coalesce(p.barcode, '') || ' '
    || coalesce(p.oem_number, '') || ' ' || coalesce(p.normalized_oem, '') || ' '
    || coalesce(p.normalized_supplier_article, '')
$$;

CREATE OR REPLACE FUNCTION public.products_set_search_text()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.search_text := public.products_search_text(NEW);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS products_search_text_trg ON public.products;
CREATE TRIGGER products_search_text_trg
  BEFORE INSERT OR UPDATE OF name, sku, barcode, oem_number, normalized_oem, normalized_supplier_article, search_text
  ON public.products FOR EACH ROW EXECUTE FUNCTION public.products_set_search_text();

-- Заповнення наявних карток. Тригер оновлення updated_at (якщо є) тут не потрібен: змінюємо лише
-- службову колонку, тому вимикаємо користувацькі тригери на час заповнення і вмикаємо назад.
ALTER TABLE public.products DISABLE TRIGGER USER;
UPDATE public.products p SET search_text = public.products_search_text(p) WHERE search_text IS DISTINCT FROM public.products_search_text(p);
ALTER TABLE public.products ENABLE TRIGGER USER;

CREATE INDEX IF NOT EXISTS idx_products_search_text_trgm ON public.products USING gin (search_text gin_trgm_ops);

-- Пошук аналогів і швидкий пошук: умови «normalized_oem = $n» / «normalized_supplier_article = $n»
-- не могли взяти наявні часткові індекси (WHERE … <> '' не доводиться для параметра) — і весь OR
-- ішов повним переглядом (~0,9 с). Звичайні індекси дозволяють BitmapOr.
CREATE INDEX IF NOT EXISTS idx_products_normalized_oem_eq ON public.products (normalized_oem);
CREATE INDEX IF NOT EXISTS idx_products_normalized_supplier_article_eq ON public.products (normalized_supplier_article);

-- Обмін ревізій: «was_counted = $n ORDER BY updated_at, id» — 3 663 запити по ~0,2 с і 70 по ~1,5 с на 94 тис. рядків.
CREATE INDEX IF NOT EXISTS idx_inventory_items_counted_updated ON public.inventory_items (was_counted, updated_at, id);

-- «Дані станом на» у вебі (тепер раз на 20 с): max(updated_at)/max(created_at) ішли повним переглядом
-- local_balance_mirror (30 тис.) і sales — ~160 мс на запит. З індексами — одне читання з кінця індексу.
CREATE INDEX IF NOT EXISTS idx_local_balance_mirror_tenant_updated ON public.local_balance_mirror (tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_sales_tenant_created ON public.sales (tenant_id, created_at);

NOTIFY pgrst, 'reload schema';
