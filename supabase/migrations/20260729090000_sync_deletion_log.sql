-- Журнал видалень для незмінних фінансових записів, які фізично видаляються.
-- Без нього інші локальні пристрої продовжують бачити стару виплату/рух каси.
CREATE TABLE IF NOT EXISTS sync_deletions (
  tenant_id UUID NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('salary_payment', 'cash_operation')),
  entity_id UUID NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_deletions_tenant_time
  ON sync_deletions (tenant_id, deleted_at);

ALTER TABLE sync_deletions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sync_deletions_tenant_select ON sync_deletions;
CREATE POLICY sync_deletions_tenant_select ON sync_deletions
  FOR SELECT
  TO authenticated
  USING (tenant_id = (SELECT app.user_tenant_id()));

DROP POLICY IF EXISTS sync_deletions_staff_write ON sync_deletions;
CREATE POLICY sync_deletions_staff_write ON sync_deletions
  FOR ALL
  TO authenticated
  USING (
    tenant_id = (SELECT app.user_tenant_id())
    AND (SELECT app.has_role(ARRAY['owner', 'admin']))
  )
  WITH CHECK (
    tenant_id = (SELECT app.user_tenant_id())
    AND (SELECT app.has_role(ARRAY['owner', 'admin']))
  );
