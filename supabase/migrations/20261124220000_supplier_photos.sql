-- Фото товарів постачальника (слово власника 24.11.2026: «в Омеги є завантаження фото по API… не більше 300 на годину,
-- нехай вантажить, ми нікуди не поспішаємо»). Омега блокує обліковий запис за перевищення 30 запитів/хв чи 300/год,
-- тому сервер веде ОДИН лічильник на всі запити до постачальника (прайс + фото) і зупиняється із запасом.
ALTER TABLE public.supplier_api_connections ADD COLUMN IF NOT EXISTS calls_hour_start timestamptz;
ALTER TABLE public.supplier_api_connections ADD COLUMN IF NOT EXISTS calls_hour_count integer NOT NULL DEFAULT 0;
ALTER TABLE public.supplier_api_connections ADD COLUMN IF NOT EXISTS calls_minute_start timestamptz;
ALTER TABLE public.supplier_api_connections ADD COLUMN IF NOT EXISTS calls_minute_count integer NOT NULL DEFAULT 0;
ALTER TABLE public.supplier_api_connections ADD COLUMN IF NOT EXISTS photos_enabled boolean NOT NULL DEFAULT true;

-- Коли питали фото в постачальника (щоб не питати те саме щоразу) і коли фото зʼявилось у нас.
ALTER TABLE public.supplier_offers ADD COLUMN IF NOT EXISTS photo_checked_at timestamptz;
ALTER TABLE public.supplier_offers ADD COLUMN IF NOT EXISTS photo_saved_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_supplier_offers_photo_queue ON public.supplier_offers (connection_id, photo_checked_at NULLS FIRST) WHERE image_url IS NULL;

-- Відкрите сховище для фото товарів постачальників: їх показує сайт і бланк замовлення. Писати може лише сервер.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('supplier-photos', 'supplier-photos', true, 1048576, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO NOTHING;
