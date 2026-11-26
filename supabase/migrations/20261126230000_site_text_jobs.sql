-- 26.11.2026, слово власника: «помічник сайту — великими пачками, без купи підтверджень, але щоб не робив дурниць;
-- це робиться раз для всіх товарів». Масова робота над текстами товарів для сайту: 10 зразків → одне «годиться» →
-- сервер сам проходить усі товари й пише на сайт; сумнівні тексти відкладаються; усе можна повернути як було.
-- Нові обʼєкти лише для програми; обʼєкти розробника сайту (site_link, site_catalog_export тощо) не зачіпаються.

CREATE TABLE IF NOT EXISTS public.site_text_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  created_by  uuid NOT NULL,
  scope       text NOT NULL CHECK (scope IN ('site_missing', 'in_stock', 'all')),
  overwrite   boolean NOT NULL DEFAULT false,
  style_note  text CHECK (style_note IS NULL OR char_length(style_note) <= 2000),
  status      text NOT NULL DEFAULT 'sample' CHECK (status IN ('sample', 'sample_ready', 'running', 'paused', 'reverting', 'done', 'cancelled')),
  total       integer NOT NULL DEFAULT 0,
  processed   integer NOT NULL DEFAULT 0,
  written     integer NOT NULL DEFAULT 0,
  review      integer NOT NULL DEFAULT 0,
  skipped     integer NOT NULL DEFAULT 0,
  failed      integer NOT NULL DEFAULT 0,
  cost_usd    numeric(12,4) NOT NULL DEFAULT 0,
  last_error  text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_text_jobs_tenant ON public.site_text_jobs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_text_jobs_active ON public.site_text_jobs (updated_at) WHERE status IN ('sample', 'running', 'reverting');
-- Одна незавершена робота на магазин: дві одночасно писали б у ті самі товари.
CREATE UNIQUE INDEX IF NOT EXISTS uq_site_text_jobs_open ON public.site_text_jobs (tenant_id) WHERE status IN ('sample', 'sample_ready', 'running', 'paused', 'reverting');

-- old_fields — що стояло на сайті до запису (для «повернути як було»); new_fields — що написав помічник.
CREATE TABLE IF NOT EXISTS public.site_text_items (
  job_id     uuid NOT NULL REFERENCES public.site_text_jobs(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  seq        integer NOT NULL,
  name       text NOT NULL,
  state      text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'working', 'sample', 'towrite', 'written', 'review', 'skipped', 'failed', 'rejected', 'reverted')),
  old_fields jsonb,
  new_fields jsonb,
  note       text CHECK (note IS NULL OR char_length(note) <= 500),
  attempts   integer NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_site_text_items_state ON public.site_text_items (job_id, state, seq);

ALTER TABLE public.site_text_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_text_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.site_text_jobs, public.site_text_items FROM PUBLIC, anon, authenticated;
