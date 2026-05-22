-- PL-10: TTL для відкладених чеків
-- Додаємо expires_at до sales. Scheduled cleanup зупиняє "вічні" suspended чеки.

ALTER TABLE sales ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sales_suspended_expires
  ON sales (status, expires_at)
  WHERE status = 'suspended';

-- Функція очищення протермінованих відкладених чеків (викликається background job)
CREATE OR REPLACE FUNCTION cleanup_expired_suspended_sales()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE sales
  SET status = 'cancelled', updated_at = NOW()
  WHERE status = 'suspended'
    AND expires_at IS NOT NULL
    AND expires_at < NOW();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
