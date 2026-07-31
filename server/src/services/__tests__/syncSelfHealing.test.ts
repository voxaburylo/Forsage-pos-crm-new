import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const syncSource = readFileSync(new URL('../syncService.ts', import.meta.url), 'utf8')
const migration = readFileSync(
  new URL('../../../../supabase/migrations/20260731125328_allow_negative_commission_reversals.sql', import.meta.url),
  'utf8',
)

describe('sync self-healing safeguards', () => {
  it('allows only negative commission reversals and keeps ordinary salary entries positive', () => {
    expect(migration).toContain("source = 'commission_reversal' AND amount < 0")
    expect(migration).toContain("source <> 'commission_reversal' AND amount > 0")
  })

  it('uses canonical snapshots for catalog, orders and recent receipt history', () => {
    expect(syncSource).toContain('const snapshotSince = referencesIncluded ? undefined : since')
    expect(syncSource).toContain('query = withChangedSince(query, snapshotSince)')
    expect(syncSource).toContain("if (since && !referencesIncluded) query = query.gt('order.updated_at', since)")
    expect(syncSource).toContain("else query = query.gte('completed_at', historySince)")
    expect(syncSource).toContain('else query = query.or(`status.eq.open,opened_at.gte.${historySince}`)')
  })
})
