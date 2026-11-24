-- Постачальники з API (рішення власника 24.11.2026): «вкладка API-ключі; товари постачальника НЕ додаємо в номенклатуру
-- складу — це чернетка під замовлення: вбиваємо артикул — бачимо ціну, склад, залишок і вибираємо в замовлення».
-- Перший постачальник — Омега. Дані живуть лише в хмарі: це не склад магазину, каса їх не зберігає.

-- Підключення: ключ постачальника читає лише сервер (service role), назовні він не віддається ніколи.
CREATE TABLE IF NOT EXISTS public.supplier_api_connections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  provider        text NOT NULL CHECK (provider IN ('omega')),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  api_key         text NOT NULL CHECK (char_length(api_key) BETWEEN 8 AND 200),
  enabled         boolean NOT NULL DEFAULT true,
  -- Наш постачальник у програмі (для рядка замовлення); необовʼязково.
  supplier_id     uuid,
  -- Прохід прайсу сторінками: на якій сторінці зупинились і коли почали поточний прохід.
  sync_page       integer NOT NULL DEFAULT 1 CHECK (sync_page >= 1),
  sync_started_at timestamptz,
  last_full_sync_at timestamptz,
  last_error      text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  total_offers    integer NOT NULL DEFAULT 0,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)
);

-- Склади постачальника. days_to_ship — скільки днів до відправки клієнту (задає власник).
CREATE TABLE IF NOT EXISTS public.supplier_warehouses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.supplier_api_connections(id) ON DELETE CASCADE,
  code          text NOT NULL CHECK (char_length(code) BETWEEN 1 AND 120),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  city          text CHECK (city IS NULL OR char_length(city) <= 80),
  days_to_ship  integer CHECK (days_to_ship IS NULL OR days_to_ship BETWEEN 0 AND 60),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, code)
);

-- Товари постачальника — «чернетка під замовлення». stock: [{"w":"<код складу>","q":<кількість>}].
-- purchase_price — ціна постачальника для нас (не віддається на сайт), retail_price — за сіткою націнок програми.
CREATE TABLE IF NOT EXISTS public.supplier_offers (
  tenant_id      uuid NOT NULL,
  connection_id  uuid NOT NULL REFERENCES public.supplier_api_connections(id) ON DELETE CASCADE,
  external_id    text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 80),
  number         text NOT NULL CHECK (char_length(number) <= 120),
  number_code    text NOT NULL CHECK (char_length(number_code) <= 120),
  brand          text CHECK (brand IS NULL OR char_length(brand) <= 120),
  name           text NOT NULL CHECK (char_length(name) <= 400),
  barcode        text CHECK (barcode IS NULL OR char_length(barcode) <= 64),
  image_url      text CHECK (image_url IS NULL OR char_length(image_url) <= 600),
  purchase_price bigint NOT NULL CHECK (purchase_price >= 0),
  retail_price   bigint NOT NULL CHECK (retail_price >= 0),
  stock          jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_qty      integer NOT NULL DEFAULT 0,
  -- Наша картка з тим самим артикулом і брендом (якщо є). Товар постачальника карткою складу НЕ стає.
  product_id     uuid,
  seen_at        timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_supplier_offers_code ON public.supplier_offers (tenant_id, number_code);
CREATE INDEX IF NOT EXISTS idx_supplier_offers_product ON public.supplier_offers (tenant_id, product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_supplier_offers_updated ON public.supplier_offers (tenant_id, updated_at);

ALTER TABLE public.supplier_api_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_offers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_api_connections FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.supplier_warehouses FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.supplier_offers FROM PUBLIC, anon, authenticated;

-- Що бачить сайт: лише товари під замовлення з наявністю, роздрібною ціною й найкоротшим строком. Без закупки.
CREATE OR REPLACE VIEW public.site_supplier_offers AS
SELECT o.tenant_id, o.connection_id, o.external_id, o.number, o.brand, o.name, o.barcode, o.image_url, o.product_id,
       o.retail_price, o.total_qty AS supplier_qty,
       (SELECT min(w.days_to_ship) FROM jsonb_array_elements(o.stock) s
          JOIN public.supplier_warehouses w ON w.connection_id = o.connection_id AND w.code = s->>'w' AND w.is_active
         WHERE (s->>'q')::int > 0) AS min_days_to_ship,
       o.updated_at
  FROM public.supplier_offers o
  JOIN public.supplier_api_connections c ON c.id = o.connection_id AND c.enabled
 WHERE o.total_qty > 0;
REVOKE ALL ON public.site_supplier_offers FROM PUBLIC, anon, authenticated;

-- Планувальник бази будить сервер раз на 5 хв; сервер сам вирішує, чи настав час наступної порції прайсу.
INSERT INTO public.internal_job_keys (name, key)
VALUES ('supplier-sync', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
ON CONFLICT (name) DO NOTHING;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'forsage-supplier-sync') THEN
    PERFORM cron.unschedule('forsage-supplier-sync');
  END IF;
END $$;
SELECT cron.schedule(
  'forsage-supplier-sync',
  '*/5 * * * *',
  $job$
    SELECT net.http_get(
      url := 'https://forsage-pos-crm-new-web.vercel.app/api/v1/internal/supplier-sync',
      headers := jsonb_build_object('x-forsage-job-key', (SELECT key FROM public.internal_job_keys WHERE name = 'supplier-sync')),
      timeout_milliseconds := 25000
    );
  $job$
);
