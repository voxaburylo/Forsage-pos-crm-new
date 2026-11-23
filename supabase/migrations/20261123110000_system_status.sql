-- 23.11.2026 (план T2 і T3).
-- T2 «Стан системи»: каса разом із «я на зв'язку» раз на кілька хвилин повідомляє про себе — версію, вікно чи фон,
-- останні копії бази, вільне місце на диску. Сервер зберігає останнє повідомлення; власник бачить його у вебі.
ALTER TABLE public.till_presence
  ADD COLUMN IF NOT EXISTS status_report jsonb,
  ADD COLUMN IF NOT EXISTS status_reported_at timestamptz;

-- T3: помилки сервера записуються в базу, а не лише в журнал хостингу (його не завжди можна прочитати).
-- Без особистих даних: адреса без параметрів, код помилки й технічний текст. Зберігаються 30 днів.
CREATE TABLE IF NOT EXISTS public.server_errors (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  route text,
  status integer,
  code text,
  message text NOT NULL,
  repeats integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_server_errors_tenant_created ON public.server_errors (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_server_errors_created ON public.server_errors (created_at);

-- Читає й пише лише сервер (службове підключення). З браузера таблиця недоступна.
ALTER TABLE public.server_errors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.server_errors FROM anon, authenticated;
