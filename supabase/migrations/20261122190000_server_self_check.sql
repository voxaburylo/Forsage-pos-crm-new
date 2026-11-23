-- 22.11.2026: самоперевірка сервера. Того дня «помилку сервера» у вебі знайшов власник із телефона.
-- Тепер сервер після кожної публікації й раз на три години сам відкриває свої сторінки читання на справжній
-- базі й повідомляє про «внутрішню помилку». Тут: останній результат, ключ планувальника і сам розклад.

CREATE TABLE IF NOT EXISTS public.server_self_check (
  id         smallint PRIMARY KEY CHECK (id = 1),
  checked_at timestamptz,
  commit     text,
  result     jsonb
);
ALTER TABLE public.server_self_check ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.server_self_check FROM PUBLIC, anon, authenticated;

INSERT INTO public.internal_job_keys (name, key)
VALUES ('self-check', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
ON CONFLICT (name) DO NOTHING;

-- Повторне застосування не створює другого завдання.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'forsage-self-check') THEN
    PERFORM cron.unschedule('forsage-self-check');
  END IF;
END $$;

-- Стукаємо кожні 10 хвилин; сервер сам вирішує, чи час (нова публікація або минуло три години).
SELECT cron.schedule(
  'forsage-self-check',
  '*/10 * * * *',
  $job$
    SELECT net.http_get(
      url := 'https://forsage-pos-crm-new-web.vercel.app/api/v1/internal/self-check',
      headers := jsonb_build_object('x-forsage-job-key', (SELECT key FROM public.internal_job_keys WHERE name = 'self-check')),
      timeout_milliseconds := 25000
    );
  $job$
);
