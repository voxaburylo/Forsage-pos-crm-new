-- 22.11.2026 (етап 11 плану): тривоги власнику в Telegram.
-- 1) журнал надісланих тривог — щоб та сама тривога не приходила двічі;
-- 2) пороги тривог у налаштуваннях магазину (необов'язкові: без них діють значення за замовчуванням);
-- 3) ключ планувальника, який створює сама база (нікуди не виноситься);
-- 4) запуск перевірки кожні 5 хвилин (pg_cron + pg_net): на Vercel власного планувальника немає.

CREATE TABLE IF NOT EXISTS public.owner_alert_log (
  tenant_id  uuid        NOT NULL,
  alert_key  text        NOT NULL CHECK (char_length(alert_key) BETWEEN 3 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, alert_key)
);
CREATE INDEX IF NOT EXISTS owner_alert_log_created_idx ON public.owner_alert_log (created_at);
ALTER TABLE public.owner_alert_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.owner_alert_log FROM PUBLIC, anon, authenticated;

ALTER TABLE public.shop_settings ADD COLUMN IF NOT EXISTS owner_alerts jsonb;

CREATE TABLE IF NOT EXISTS public.internal_job_keys (
  name       text PRIMARY KEY,
  key        text NOT NULL CHECK (char_length(key) >= 32),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.internal_job_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.internal_job_keys FROM PUBLIC, anon, authenticated;
INSERT INTO public.internal_job_keys (name, key)
VALUES ('owner-alerts', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
ON CONFLICT (name) DO NOTHING;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Повторне застосування не створює другого завдання.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'forsage-owner-alerts') THEN
    PERFORM cron.unschedule('forsage-owner-alerts');
  END IF;
END $$;

SELECT cron.schedule(
  'forsage-owner-alerts',
  '*/5 * * * *',
  $job$
    SELECT net.http_get(
      url := 'https://forsage-pos-crm-new-web.vercel.app/api/v1/internal/owner-alerts',
      headers := jsonb_build_object('x-forsage-job-key', (SELECT key FROM public.internal_job_keys WHERE name = 'owner-alerts')),
      timeout_milliseconds := 25000
    );
  $job$
);
