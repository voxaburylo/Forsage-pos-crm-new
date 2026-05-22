-- ============================================================
-- E-14: Print Center — журнал задач друку
-- ============================================================

CREATE TABLE IF NOT EXISTS print_jobs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
    document_type VARCHAR(50) NOT NULL, -- 'receipt', 'label', 'order', 'picking_list'
    document_id   UUID,
    title         TEXT NOT NULL,
    copies        SMALLINT NOT NULL DEFAULT 1,
    status        VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, printed, failed
    printed_at    TIMESTAMPTZ,
    printed_by    UUID REFERENCES auth.users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_print_jobs_tenant ON print_jobs(tenant_id, created_at DESC);

ALTER TABLE print_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "print_jobs_all" ON print_jobs FOR ALL USING (true);
