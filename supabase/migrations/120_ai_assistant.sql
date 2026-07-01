-- 120_ai_assistant.sql
-- AI-помічник «Директор» (Gemini): ключ, модель, увімкнення + облік витрат токенів.
-- Ідемпотентно (IF NOT EXISTS) — безпечно застосовувати повторно.

-- ── Налаштування AI у магазині ────────────────────────────────────────────────
-- Ключ зберігається зашифрованим (AES-256-GCM) у ai_api_key_encrypted, тому в
-- open-text вигляді його ніколи немає ні в БД, ні у відповіді /settings.
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS ai_enabled           BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS ai_model             VARCHAR(60) NOT NULL DEFAULT 'gemini-2.5-flash';
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS ai_api_key_encrypted TEXT;

-- ── Облік використання (лічильник вартості) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_usage (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL,
  user_id           UUID,
  model             VARCHAR(60) NOT NULL,
  prompt_tokens     INTEGER     NOT NULL DEFAULT 0,
  completion_tokens INTEGER     NOT NULL DEFAULT 0,
  total_tokens      INTEGER     NOT NULL DEFAULT 0,
  cost_usd          NUMERIC(12,6) NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_tenant_created ON ai_usage(tenant_id, created_at DESC);

ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ai_usage' AND policyname = 'ai_usage_all'
  ) THEN
    CREATE POLICY ai_usage_all ON ai_usage FOR ALL USING (true);
  END IF;
END $$;

-- PostgREST кешує схему — інакше нові колонки/таблиця лишаються "невидимими".
NOTIFY pgrst, 'reload schema';
