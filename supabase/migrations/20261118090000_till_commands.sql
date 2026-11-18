-- Запис із вебу через касу (рішення власника 17.11.2026). Веб не пише в каталог сам:
-- він ставить команду, каса в мережі забирає її за кілька секунд, виконує у своїй базі й відповідає.
-- Черги немає: команда, яку не забрали за 30 с, не виконується ніколи.
CREATE TABLE IF NOT EXISTS public.till_commands (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  operation_id  uuid NOT NULL,
  command       text NOT NULL CHECK (command IN ('product.update')),
  payload       jsonb NOT NULL,
  requested_by  uuid NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'done', 'failed', 'expired')),
  device_id     uuid,
  result        jsonb,
  error         text CHECK (error IS NULL OR char_length(error) <= 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz,
  finished_at   timestamptz,
  UNIQUE (tenant_id, operation_id)
);
CREATE INDEX IF NOT EXISTS idx_till_commands_pending ON public.till_commands (tenant_id, created_at) WHERE status = 'pending';

-- Коли каса востаннє питала про команди: веб показує «зберегти через касу» лише коли вона в мережі.
CREATE TABLE IF NOT EXISTS public.till_presence (
  tenant_id  uuid PRIMARY KEY,
  device_id  uuid NOT NULL,
  seen_at    timestamptz NOT NULL DEFAULT now()
);

-- Доступ лише через сервер (service role); жодних прямих прав для anon/authenticated.
ALTER TABLE public.till_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.till_presence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.till_commands FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.till_presence FROM PUBLIC, anon, authenticated;
