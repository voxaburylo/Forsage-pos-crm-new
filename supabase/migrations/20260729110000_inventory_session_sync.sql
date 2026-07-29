-- Розширюємо журнал видалень на порожні незавершені ревізії.
-- Самі ревізії фізично видаляються, тому іншим пристроям потрібен tombstone.
ALTER TABLE sync_deletions
  DROP CONSTRAINT IF EXISTS sync_deletions_entity_type_check;

ALTER TABLE sync_deletions
  ADD CONSTRAINT sync_deletions_entity_type_check
  CHECK (entity_type IN ('salary_payment', 'cash_operation', 'inventory_session'));