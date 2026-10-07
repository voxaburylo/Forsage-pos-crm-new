import type { PoolClient } from 'pg'

type Entity = 'salary_payment' | 'cash_operation'

// Every path takes salary first, then its cash lock. A row lock alone cannot
// protect a document that has not arrived yet. Transaction locks also work
// through the Supabase transaction pooler and release on rollback.
export async function lockFinancialCopy(client: PoolClient, entity: Entity, id: string): Promise<void> {
  const prefix = entity === 'salary_payment' ? 'salary-copy:' : 'salary-cash-copy:'
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [prefix + id])
}

export async function financialCopyDeleted(client: PoolClient, tenant: string, entity: Entity, id: string): Promise<boolean> {
  const result = await client.query(
    'SELECT 1 FROM sync_deletions WHERE tenant_id=$1 AND entity_type=$2 AND entity_id=$3',
    [tenant, entity, id],
  )
  return Boolean(result.rowCount)
}

export async function markFinancialCopyDeleted(client: PoolClient, tenant: string, entity: Entity, id: string): Promise<void> {
  // Keep the first tombstone on retries, so a stale message cannot advance a
  // deletion cursor forever. Server time, not a possibly old offline timestamp.
  await client.query(`INSERT INTO sync_deletions(tenant_id,entity_type,entity_id,deleted_at)
    VALUES($1,$2,$3,clock_timestamp()) ON CONFLICT(tenant_id,entity_type,entity_id) DO NOTHING`,
  [tenant, entity, id])
}
