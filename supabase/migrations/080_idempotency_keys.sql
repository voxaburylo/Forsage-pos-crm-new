-- PL-01: Таблиця для idempotency keys
-- Запобігає подвійному продажу при network timeout + retry

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        TEXT    NOT NULL,
  tenant_id  UUID    NOT NULL,
  response   JSONB   NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (key, tenant_id)
);

-- Для автоматичного cleanup старих записів (>24h)
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
  ON idempotency_keys (created_at);
