-- Зберігаємо tombstone накладної, щоб усі локальні пристрої отримали видалення.
ALTER TABLE supply_invoices
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_supply_invoices_deleted_sync
  ON supply_invoices(tenant_id, updated_at)
  WHERE deleted_at IS NOT NULL;
