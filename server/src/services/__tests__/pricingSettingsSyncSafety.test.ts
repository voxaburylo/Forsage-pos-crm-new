import { syncModuleSource as syncSource } from './helpers/syncSource.js'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pricingServiceSource = readFileSync(new URL('../pricingService.ts', import.meta.url), 'utf8')
const pricingApiSource = readFileSync(
  new URL('../../../../apps/web/src/features/admin/pricingApi.ts', import.meta.url),
  'utf8',
)
const catalogSource = readFileSync(
  new URL('../../../../apps/desktop/src/repositories/catalogRepository.ts', import.meta.url),
  'utf8',
)

describe('local-first pricing settings synchronization', () => {
  it('pulls server tiers and category markups into the local settings snapshot', () => {
    expect(syncSource).toContain("db.from('price_tiers')")
    expect(syncSource).toContain("db.from('category_markups')")
    expect(syncSource).toContain('price_tiers: tiersResult.data ?? []')
    expect(syncSource).toContain('category_markups: markupsResult.data ?? []')
  })

  it('queues explicit local upserts and deletions instead of relying on unsupported shop columns', () => {
    for (const key of [
      'price_tier_upserts',
      'price_tier_deleted_ids',
      'category_markup_upserts',
      'category_markup_deleted_ids',
    ]) {
      expect(pricingApiSource).toContain(key)
      expect(syncSource).toContain(key)
      expect(catalogSource).toContain(key)
    }
  })

  it('maps the offline placeholder default tier to a real server UUID', () => {
    expect(syncSource).toContain("if (id === 'default')")
    expect(syncSource).toContain('id = defaultTier.rows[0]?.id ?? randomUUID()')
  })

  it('keeps transient operation commands out of persistent local settings', () => {
    expect(catalogSource).toContain('const transientKeys = new Set([')
    expect(catalogSource).toContain('...persistentInput')
  })
  it('deletes a web price tier safely without leaving broken customer references', () => {
    expect(pricingServiceSource).toContain('SELECT id, is_default FROM price_tiers')
    expect(pricingServiceSource).toContain('Основний рівень ціни не можна видалити')
    expect(pricingServiceSource).toContain('UPDATE customers SET price_tier_id = NULL')
  })
})