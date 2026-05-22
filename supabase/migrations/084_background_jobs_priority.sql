-- PL-33: Priority field для sys_background_jobs
-- Вища цифра = вищий пріоритет. Default = 5 (середній).
-- Критичні задачі (sale-related) → 10, cleanup → 1

ALTER TABLE sys_background_jobs
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 5;

-- Оновлюємо індекс: тепер враховуємо priority
DROP INDEX IF EXISTS idx_sys_background_jobs_status_scheduled;

CREATE INDEX IF NOT EXISTS idx_sys_background_jobs_pending
  ON sys_background_jobs (priority DESC, scheduled_at ASC)
  WHERE status = 'pending';

-- Оновлюємо claim_next_job: ORDER BY priority DESC, scheduled_at ASC
CREATE OR REPLACE FUNCTION claim_next_job(worker_id VARCHAR)
RETURNS TABLE (
    id UUID,
    tenant_id UUID,
    job_type VARCHAR,
    payload JSONB,
    attempts INTEGER,
    max_attempts INTEGER
) AS $$
#variable_conflict use_column
DECLARE
    claimed_job_id UUID;
BEGIN
    SELECT j.id INTO claimed_job_id
    FROM sys_background_jobs j
    WHERE j.status = 'pending'
      AND j.scheduled_at <= NOW()
    ORDER BY j.priority DESC, j.scheduled_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF claimed_job_id IS NOT NULL THEN
        UPDATE sys_background_jobs
        SET status = 'processing',
            attempts = sys_background_jobs.attempts + 1,
            updated_at = NOW(),
            error_message = 'Claimed by ' || worker_id
        WHERE sys_background_jobs.id = claimed_job_id;

        RETURN QUERY
        SELECT j.id, j.tenant_id, j.job_type, j.payload, j.attempts, j.max_attempts
        FROM sys_background_jobs j
        WHERE j.id = claimed_job_id;
    END IF;
END;
$$ LANGUAGE plpgsql;
