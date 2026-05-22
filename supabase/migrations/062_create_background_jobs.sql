-- Create sys_background_jobs table
CREATE TABLE IF NOT EXISTS sys_background_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
    job_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(50) DEFAULT 'pending' NOT NULL, -- 'pending', 'processing', 'completed', 'failed'
    attempts INTEGER DEFAULT 0 NOT NULL,
    max_attempts INTEGER DEFAULT 3 NOT NULL,
    error_message TEXT,
    scheduled_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Index for scanning pending jobs
CREATE INDEX IF NOT EXISTS idx_sys_background_jobs_status_scheduled 
ON sys_background_jobs(status, scheduled_at) 
WHERE status = 'pending';

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
    ORDER BY j.scheduled_at ASC
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
