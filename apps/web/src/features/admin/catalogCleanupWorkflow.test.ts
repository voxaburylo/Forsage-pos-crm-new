import { describe, expect, it } from 'vitest'
import {
  cleanupGroupsPage, cleanupLevelCounts, cleanupScanAfterMerge, cleanupSelectionBlockers, defaultCleanupReason,
  manualCleanupGroup, MANUAL_GROUP_ID, searchCleanupProducts, type CleanupGroup, type CleanupProduct, type CleanupScan,
} from './catalogCleanupModel'

/** Скарга власника 15.11.2026: вкладкою об'єднання неможливо користуватись. */
const product = (id: string, name: string, extra: Partial<CleanupProduct> = {}): CleanupProduct =>
  ({ id, name, sku: 'S-' + id, unit: 'шт', qty_on_hand: 0, retail_price: 10000, fingerprint: 'f-' + id, ...extra })
const group = (id: string, level: CleanupGroup['level'], ids: string[], confidence?: number): CleanupGroup =>
  ({ id, level, product_ids: ids, reasons: ['Спільний артикул у полі або назві'], conflicts: level === 'conflict' ? ['Різні бренди'] : [], confidence })

const scan: CleanupScan = {
  products: [
    product('a', 'Фільтр повітряний OPEL VIVARO', { sku: 'WA6684', barcode: '5050026343761', qty_on_hand: 1 }),
    product('b', 'Воздушный фильтр WIX WA6684 Renault', { barcode: '2000998840877' }),
    product('c', 'Термостат Fitshi'), product('d', 'Термостат Fitshi 6833'),
    product('e', 'Олива Mannol 1л'), product('f', 'Олива Mannol 4л'),
    product('g', 'Щітка Alca 560', { qty_on_hand: 3 }), product('h', 'Щетка Alca 560 мм'),
    product('lonely', 'Свічка NGK BKR5ES-11', { additional_barcodes: ['4820000000031'] }),
  ],
  groups: [
    group('conflict', 'conflict', ['e', 'f']),
    group('review-empty', 'review', ['c', 'd'], 60),
    group('exact-empty', 'exact', ['c', 'd'], 95),
    group('review-stock', 'review', ['g', 'h'], 40),
    group('exact-stock', 'exact', ['a', 'b'], 86),
  ],
  sku_suggestions: [{ product_id: 'b', sku: 'WA6684', evidence: 'Назва містить WA6684', preview_fingerprint: 'p' }],
  total: 9,
}

describe('duplicate list is a work queue, not a report', () => {
  it('hides contradictions by default and puts likely duplicates with stock first', () => {
    const rows = cleanupGroupsPage(scan, 'merge', '', 0).rows.map(row => row.id)
    expect(rows).toEqual(['exact-stock', 'exact-empty', 'review-stock', 'review-empty'])
    expect(cleanupGroupsPage(scan, 'conflict', '', 0).rows.map(row => row.id)).toEqual(['conflict'])
    expect(cleanupGroupsPage(scan, 'all', '', 0).total).toBe(5)
    expect(cleanupGroupsPage(scan, 'exact', '', 0).total).toBe(2)
  })

  it('reports how much work each level holds', () => {
    expect(cleanupLevelCounts(scan)).toEqual({ exact: 2, review: 2, conflict: 1 })
  })

  it('keeps the order of an older scan that sends no confidence', () => {
    const legacy = { ...scan, groups: scan.groups.map(({ confidence: _ignored, ...rest }) => rest) }
    expect(cleanupGroupsPage(legacy, 'exact', '', 0).rows.map(row => row.id)).toEqual(['exact-stock', 'exact-empty'])
  })
})

describe('manual merge of cards the search did not pair', () => {
  it('finds any catalog card by name, article or barcode, skipping the ones already chosen', () => {
    expect(searchCleanupProducts(scan, 'wa6684').map(row => row.id)).toEqual(['a', 'b'])
    expect(searchCleanupProducts(scan, '4820000000031').map(row => row.id)).toEqual(['lonely'])
    expect(searchCleanupProducts(scan, 'ngk bkr5es').map(row => row.id)).toEqual(['lonely'])
    expect(searchCleanupProducts(scan, 'wa6684', ['a']).map(row => row.id)).toEqual(['b'])
    expect(searchCleanupProducts(scan, 'термостат', [], 1)).toHaveLength(1)
  })

  it('does not list the whole catalog for an empty or one-letter query', () => {
    expect(searchCleanupProducts(scan, '')).toEqual([])
    expect(searchCleanupProducts(scan, ' ф ')).toEqual([])
  })

  it('builds an ordinary reviewable group that passes the same selection rules', () => {
    const manual = manualCleanupGroup(['lonely', 'a', 'lonely'])
    expect(manual).toMatchObject({ id: MANUAL_GROUP_ID, level: 'review', product_ids: ['lonely', 'a'], conflicts: [] })
    expect(cleanupSelectionBlockers(scan, manual, 'a', ['lonely'])).toEqual([])
    expect(cleanupSelectionBlockers(scan, manual, 'a', [])).toContain('Позначте картки, які потрібно об’єднати з основною.')
    expect(cleanupSelectionBlockers(scan, manual, 'a', ['b'])).not.toEqual([])
    expect(defaultCleanupReason(manual)).toContain('вручну')
    expect(defaultCleanupReason(scan.groups[4])).toContain('Спільний артикул')
  })
})

describe('list after a confirmed merge', () => {
  it('drops merged cards and every group touching them without a new catalog scan', () => {
    const next = cleanupScanAfterMerge(scan, 'a', ['b'], 1)
    expect(next.products.map(row => row.id)).not.toContain('b')
    expect(next.products.find(row => row.id === 'a')?.qty_on_hand).toBe(1)
    expect(next.groups.map(row => row.id)).toEqual(['conflict', 'review-empty', 'exact-empty', 'review-stock'])
    expect(next.sku_suggestions).toEqual([])
    expect(next.total).toBe(8)
    // Вхідні дані не змінюються: невдалий запис не має псувати список на екрані.
    expect(scan.products).toHaveLength(9)
    expect(scan.groups).toHaveLength(5)
  })

  it('shows the summed stock on the kept card and removes overlapping groups of both cards', () => {
    const next = cleanupScanAfterMerge(scan, 'c', ['d'], 7)
    expect(next.products.find(row => row.id === 'c')?.qty_on_hand).toBe(7)
    expect(next.groups.map(row => row.id)).toEqual(['conflict', 'review-stock', 'exact-stock'])
    expect(searchCleanupProducts(next, 'термостат').map(row => row.id)).toEqual(['c'])
  })
})
