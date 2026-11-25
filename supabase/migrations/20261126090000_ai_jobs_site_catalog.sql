-- 26.11.2026, слово власника: «помічник бере по 200 товарів і робить це дуже довго; товарів може бути мільйони;
-- хай працює на сервері у фоні; на будь-якому пристрої той самий чат; у вкладці “Сайт” — усі товари, наші й від
-- постачальників, у купі: перегляд, редагування, штрихкод, масова робота з цінами, видалення».
-- Лише нові таблиці й нові поля. Наявні дані не змінюються.

-- 1. Фонові задачі помічника: порядок у назвах / переклад пачками на сервері.
CREATE TABLE IF NOT EXISTS public.ai_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  created_by    uuid,
  target        text NOT NULL CHECK (target IN ('products', 'supplier_offers')),
  task          text NOT NULL CHECK (task IN ('cleanup', 'translate', 'cleanup_translate')),
  filter        text NOT NULL DEFAULT 'messy_names' CHECK (filter IN ('messy_names', 'russian_names', 'all')),
  connection_id uuid REFERENCES public.supplier_api_connections(id) ON DELETE CASCADE,
  title         text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  status        text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'running', 'paused', 'review', 'done', 'cancelled')),
  total         integer NOT NULL DEFAULT 0,
  processed     integer NOT NULL DEFAULT 0,
  changed       integer NOT NULL DEFAULT 0,
  suspicious    integer NOT NULL DEFAULT 0,
  applied       integer NOT NULL DEFAULT 0,
  cost_usd      numeric(12, 4) NOT NULL DEFAULT 0,
  started_at    timestamptz,
  last_error    text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_jobs_tenant ON public.ai_jobs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_jobs_running ON public.ai_jobs (updated_at) WHERE status = 'running';

-- item_key: id товару програми або «<connection_id>:<external_id>» товару постачальника.
CREATE TABLE IF NOT EXISTS public.ai_job_items (
  job_id     uuid NOT NULL REFERENCES public.ai_jobs(id) ON DELETE CASCADE,
  item_key   text NOT NULL CHECK (char_length(item_key) BETWEEN 1 AND 160),
  seq        integer NOT NULL,
  old_name   text NOT NULL,
  sku        text,
  new_name   text CHECK (new_name IS NULL OR char_length(new_name) <= 400),
  new_sku    text CHECK (new_sku IS NULL OR char_length(new_sku) <= 120),
  state      text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'working', 'proposed', 'suspicious', 'unchanged', 'applied', 'rejected', 'failed')),
  note       text CHECK (note IS NULL OR char_length(note) <= 500),
  claimed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_ai_job_items_state ON public.ai_job_items (job_id, state, seq);

-- 2. Спільний чат помічника: той самий на телефоні й на ПК (раніше — лише в памʼяті кожного пристрою).
CREATE TABLE IF NOT EXISTS public.ai_chats (
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('assistant', 'invoice')),
  state      jsonb NOT NULL DEFAULT '{}'::jsonb,
  saved_at   bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, kind)
);

-- 3. Товари постачальників у вкладці «Сайт»: власна назва (наведення порядку), штрихкод, ціна для сайту, «прибрати».
-- Окремі поля: прайс постачальника кожні 3 год перезаписує name/barcode/retail_price, а ці — ні.
ALTER TABLE public.supplier_offers
  ADD COLUMN IF NOT EXISTS custom_name    text CHECK (custom_name IS NULL OR char_length(custom_name) BETWEEN 1 AND 400),
  ADD COLUMN IF NOT EXISTS custom_barcode text CHECK (custom_barcode IS NULL OR char_length(custom_barcode) BETWEEN 1 AND 64),
  ADD COLUMN IF NOT EXISTS custom_price   bigint CHECK (custom_price IS NULL OR custom_price >= 0),
  ADD COLUMN IF NOT EXISTS hidden         boolean NOT NULL DEFAULT false;

-- Сайт бачить нашу назву, штрихкод і ціну, якщо вони задані; прибрані товари не бачить. Стовпці ті самі, що й були.
CREATE OR REPLACE VIEW public.site_supplier_offers AS
SELECT o.tenant_id, o.connection_id, o.external_id, o.number, o.brand,
       COALESCE(o.custom_name, o.name) AS name,
       COALESCE(o.custom_barcode, o.barcode) AS barcode,
       o.image_url, o.product_id,
       COALESCE(o.custom_price, o.retail_price) AS retail_price,
       o.total_qty AS supplier_qty,
       (SELECT min(w.days_to_ship) FROM jsonb_array_elements(o.stock) s
          JOIN public.supplier_warehouses w ON w.connection_id = o.connection_id AND w.code = s->>'w' AND w.is_active
         WHERE (s->>'q')::int > 0) AS min_days_to_ship,
       o.updated_at, o.category_id
  FROM public.supplier_offers o
  JOIN public.supplier_api_connections c ON c.id = o.connection_id AND c.enabled
 WHERE o.total_qty > 0 AND NOT o.hidden;
REVOKE ALL ON public.site_supplier_offers FROM PUBLIC, anon, authenticated;

-- Таблиці читає й пише лише сервер (ключ сервісу). Браузерам доступу немає.
ALTER TABLE public.ai_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_job_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_chats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_jobs, public.ai_job_items, public.ai_chats FROM PUBLIC, anon, authenticated;

-- Планувальник бази будить обробник задач щохвилини; якщо задач немає, сервер одразу відповідає «нічого».
INSERT INTO public.internal_job_keys (name, key)
VALUES ('ai-jobs', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
ON CONFLICT (name) DO NOTHING;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'forsage-ai-jobs') THEN
    PERFORM cron.unschedule('forsage-ai-jobs');
  END IF;
END $$;
SELECT cron.schedule(
  'forsage-ai-jobs',
  '* * * * *',
  $job$
    SELECT net.http_get(
      url := 'https://forsage-pos-crm-new-web.vercel.app/api/v1/internal/ai-jobs',
      headers := jsonb_build_object('x-forsage-job-key', (SELECT key FROM public.internal_job_keys WHERE name = 'ai-jobs')),
      timeout_milliseconds := 25000
    );
  $job$
);
