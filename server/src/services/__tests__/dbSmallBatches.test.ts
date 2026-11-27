import { beforeEach, describe, expect, it, vi } from 'vitest'

const sql = vi.hoisted(() => ({ calls: [] as Array<{ text: string; params: any[] }>, shops: [] as any[], cleared: [] as number[], offers: [] as any[], products: [] as any[] }))
vi.mock('../../db/pg.js', () => ({ pool: { query: async (text: string, params: any[] = []) => {
  sql.calls.push({ text, params })
  if (/FROM supplier_category_sort WHERE enabled OR undo_pending/.test(text)) return { rows: sql.shops }
  if (/WITH picked AS/.test(text)) return { rows: [], rowCount: sql.cleared.shift() ?? 0 }
  if (/SELECT external_id, number_code, brand, product_id FROM supplier_offers/.test(text)) return { rows: sql.offers }
  if (/FROM products p LEFT JOIN brands/.test(text)) return { rows: sql.products }
  return { rows: [], rowCount: 0 }
} } }))
import { runCategorySortStep, undoSort, undoStep, UNDO_PAGE } from '../supplierCategorySort.js'
import { AFTER_PASS_CHUNK, AFTER_PASS_MAX, linkOffers } from '../supplierApiService.js'

// 27.11.2026, власник: «щоб розкладка більше не виносила сервер» — жодного запиту на десятки тисяч рядків одразу.
describe('"put it back" in the category sort goes in portions', () => {
  beforeEach(() => { sql.calls.length = 0; sql.shops = []; sql.cleared = []; sql.offers = []; sql.products = [] })

  it('the button only sets a mark and forgets the rules; it does not touch the goods itself', async () => {
    await undoSort('t', 'u').catch(() => undefined)
    const texts = sql.calls.map(call => call.text)
    expect(texts.some(text => /undo_pending = true/.test(text))).toBe(true)
    expect(texts.some(text => /DELETE FROM supplier_category_rules/.test(text))).toBe(true)
    expect(texts.some(text => /UPDATE supplier_offers/.test(text))).toBe(false)
  })

  it('one portion is limited; the mark goes off when nothing is left', async () => {
    sql.cleared = [UNDO_PAGE, 0]
    expect(await undoStep('t')).toBe(UNDO_PAGE)
    expect(sql.calls[0].params).toEqual(['t', UNDO_PAGE])
    expect(sql.calls[0].text).toContain("category_source IN ('ai', 'ai_none', 'ai_wait') LIMIT $2")
    expect(sql.calls.some(call => /undo_pending = false/.test(call.text))).toBe(false)
    expect(await undoStep('t')).toBe(0)
    expect(sql.calls.some(call => /undo_pending = false/.test(call.text))).toBe(true)
    expect(UNDO_PAGE).toBeLessThanOrEqual(2000)
  })

  it('while it is being put back the scheduler clears a portion and does not sort that shop', async () => {
    sql.shops = [{ tenant_id: 't', started_by: 'u', undo_pending: true }]
    sql.cleared = [500]
    const result = await runCategorySortStep()
    expect(result).toMatchObject({ shops: 1, placed: 0, errors: 0 })
    expect(sql.calls.filter(call => /WITH picked AS/.test(call.text))).toHaveLength(1)
    expect(sql.calls.some(call => /category_id IS NULL AND category_source IS NULL ORDER BY/.test(call.text))).toBe(false)
  })
})

describe('the end of a price-list pass does not write tens of thousands of rows at once', () => {
  beforeEach(() => { sql.calls.length = 0; sql.offers = []; sql.products = [] })

  it('links to our cards: small chunks, a cap per pass, the rest waits for the next pass', async () => {
    // Усі товари були привʼязані, а тепер збігу немає: змінитись має кожен рядок.
    sql.offers = Array.from({ length: AFTER_PASS_MAX + 1200 }, (_, index) => ({ external_id: 's' + index, number_code: 'S' + index, brand: 'Bosch', product_id: 'p' }))
    const result = await linkOffers('t', 'c')
    const updates = sql.calls.filter(call => /UPDATE supplier_offers o SET product_id/.test(call.text))
    expect(updates).toHaveLength(AFTER_PASS_MAX / AFTER_PASS_CHUNK)
    for (const update of updates) expect(JSON.parse(update.params[1])).toHaveLength(AFTER_PASS_CHUNK)
    expect(result).toMatchObject({ changed: AFTER_PASS_MAX, postponed: 1200 })
  })
})
