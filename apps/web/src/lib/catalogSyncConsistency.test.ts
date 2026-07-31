import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { attachProductReferences, offlineProductMatchesQuery } from './offlineDB'

const desktopSyncSource = readFileSync(new URL('./desktopSyncApi.ts', import.meta.url), 'utf8')
const desktopSyncAgentSource = readFileSync(new URL('../hooks/useDesktopOutboxSync.ts', import.meta.url), 'utf8')
const serverSyncSource = readFileSync(
  new URL('../../../../server/src/services/syncService.ts', import.meta.url),
  'utf8',
)

describe('catalog synchronization consistency', () => {
  it('keeps barcode aliases and cross numbers searchable in the web cache', () => {
    const [product] = attachProductReferences(
      [{ id: 'p1', name: 'Радіатор', sku: 'RAD-1', barcode: '111' }],
      [
        { product_id: 'p1', barcode: '111', is_primary: true },
        { product_id: 'p1', barcode: '222', is_primary: false },
      ],
      [{ product_id: 'p1', alias: 'охолодження двигуна' }],
      [{ product_id: 'p1', number: 'OEM-77' }],
    )

    expect(product.additional_barcodes).toEqual(['222'])
    expect(offlineProductMatchesQuery(product, '222')).toBe(true)
    expect(offlineProductMatchesQuery(product, 'охолодження')).toBe(true)
    expect(offlineProductMatchesQuery(product, 'OEM77')).toBe(true)
  })

  it('never starts a blocking full catalog refresh from the automatic agent', () => {
    expect(desktopSyncSource).not.toContain('referencesAreStale')
    expect(desktopSyncSource).toContain('options.includeReferences === true')
    expect(desktopSyncSource).toContain('options.canApplyPull && !options.canApplyPull()')
    expect(desktopSyncAgentSource).toContain('document.visibilityState !== \'visible\'')
    expect(desktopSyncAgentSource).not.toContain('schedule(1_000, true)')
    expect(desktopSyncAgentSource).toContain('schedule(1_000)')
  })

  it('marks category snapshots only when a complete reference snapshot is returned', () => {
    expect(serverSyncSource).toContain(
      'catalog_structure_snapshot_included: referencesIncluded',
    )
    expect(serverSyncSource).toContain('await clearProductSearchCache()')
  })
})
