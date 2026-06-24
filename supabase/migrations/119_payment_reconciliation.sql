-- 119_payment_reconciliation.sql
-- Журнал платежів, що потребують ручної звірки/уваги: коли термінал міг списати
-- кошти, але результат невідомий (таймаут/обрив) або не вдалось автоскасувати при
-- відкаті продажу. Раніше це лише писалось у лог і губилось — тепер є таблиця.
-- Ідемпотентно.

CREATE TABLE IF NOT EXISTS payment_reconciliation (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  payment_ref    TEXT,                 -- order_id, переданий терміналу
  sale_id        UUID,                 -- якщо продаж усе ж створено
  amount_kopecks BIGINT NOT NULL DEFAULT 0,
  rrn            TEXT,
  auth_code      TEXT,
  pan_masked     TEXT,
  status         TEXT NOT NULL,        -- 'unknown' | 'charged_not_reversed'
  reason         TEXT,
  resolved       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_reconciliation_unresolved
  ON payment_reconciliation (tenant_id, resolved, created_at);

NOTIFY pgrst, 'reload schema';
