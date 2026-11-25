import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { cleanCardCrosses, importSupplierCrosses, SUPPLIER_CROSS_SOURCE } from './supplierCrossImport'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
// 25.11.2026 (власник: «кроси мають працювати скрізь — і в пошуку по нашій базі»): кроси Омеги — у крос-номери наших карток.
describe('Omega crosses into our cards', () => {
  it('keeps only well-formed rows and numbers', () => {
    expect(cleanCardCrosses([
      { program_product_id: id(2), found_at: '2026-11-25T20:00:02Z', numbers: [{ number: ' OC 90 ', brand: 'Knecht' }, { number: '', brand: null }, { number: '---' }] },
      { program_product_id: 'bad', found_at: '2026-11-25T20:00:00Z', numbers: [] },
      { program_product_id: id(1), found_at: '2026-11-25T20:00:01Z', numbers: [{ number: 'W712/75', brand: '' }] },
    ])).toEqual([
      { program_product_id: id(1), found_at: '2026-11-25T20:00:01Z', numbers: [{ number: 'W712/75', brand: null }] },
      { program_product_id: id(2), found_at: '2026-11-25T20:00:02Z', numbers: [{ number: 'OC 90', brand: 'Knecht' }] },
    ])
  })

  it('writes numbers into existing cards, skips missing cards, and moves the marker only past successes', async () => {
    const added: string[] = []
    let since: string | null = null
    const result = await importSupplierCrosses({
      list: async () => [
        { program_product_id: id(1), found_at: '2026-11-25T20:00:01Z', numbers: [{ number: 'A1', brand: null }] },
        { program_product_id: id(2), found_at: '2026-11-25T20:00:02Z', numbers: [{ number: 'B2', brand: null }] },
        { program_product_id: id(3), found_at: '2026-11-25T20:00:03Z', numbers: [{ number: 'C3', brand: null }] },
        { program_product_id: id(4), found_at: '2026-11-25T20:00:04Z', numbers: [{ number: 'D4', brand: null }] },
      ],
      hasCard: async card => card !== id(2),
      addCrosses: async (card) => { if (card === id(3)) throw new Error('disk'); added.push(card) },
      readSince: () => since, writeSince: value => { since = value },
    })
    expect(added).toEqual([id(1), id(4)])
    expect(result).toMatchObject({ received: 4, cards: 2, skippedNoCard: 1, failed: 1 })
    expect(since).toBe('2026-11-25T20:00:02Z')
  })

  it('the main PC runs it hourly next to the supplier photos, marking the source as Omega', () => {
    expect(SUPPLIER_CROSS_SOURCE).toContain('Омега')
    expect(readFileSync(new URL('../../hooks/useTillLink.ts', import.meta.url), 'utf8')).toContain("runSupplierCrossImport()")
    const till = readFileSync(new URL('../../../../desktop/src/link/tillDeviceLink.ts', import.meta.url), 'utf8')
    expect(till).toContain('/^\\/supplier-crosses(?:')
  })
})
