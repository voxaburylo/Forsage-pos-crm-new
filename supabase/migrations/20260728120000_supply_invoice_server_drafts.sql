-- Server-side editable drafts for web supply invoices.
-- Keeps unfinished receiving work visible from another browser/device before the invoice is posted.
ALTER TABLE supply_invoices
  ADD COLUMN IF NOT EXISTS draft_payload JSONB,
  ADD COLUMN IF NOT EXISTS draft_saved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS draft_saved_by UUID;

CREATE INDEX IF NOT EXISTS idx_supply_invoices_draft_saved_at
  ON supply_invoices(tenant_id, status, draft_saved_at DESC)
  WHERE status = 'draft' AND draft_payload IS NOT NULL;