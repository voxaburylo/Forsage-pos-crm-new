import { describe, expect, it } from 'vitest'
import {
  cleanupGroupsPage, cleanupSelectionBlockers, cleanupApplyInput, cleanupSkuInput,
  retainCleanupOperation, type CleanupProduct, type CleanupScan, type CleanupPreview,
} from './catalogCleanupModel'

const product = (id: string, name = 'Олива Mannol 5W30 4л'): CleanupProduct => ({ id, name, sku: 'ART-' + id, brand: 'Mannol', unit: 'шт', qty_on_hand: 2, fingerprint: 'field-' + id })
const products = [product('target'), product('source')]
const scan: CleanupScan = { products, groups: [{ id: 'g', level: 'exact', product_ids: ['target', 'source'], reasons: ['Однакові назви'], conflicts: [], suggested_target_id: 'target' }], sku_suggestions: [], total: 2 }
const preview: CleanupPreview = { target_id: 'target', source_ids: ['source'], products, fingerprint: 'preview-snapshot', blockers: [], warnings: [], quantity_before: [2, 2], quantity_after: 4, barcodes: [], photos: [], history_counts: {}, can_apply: true, stock_review: 'pending' }

describe('catalog cleanup explicit review boundary', () => {
  it('finds groups by full name, secondary barcode and SKU without hiding conflicts', () => {
    const source = { ...product('source', 'Олива 5W30 4л специфікація C3'), additional_barcodes: ['2000000000001'] }
    const data = { ...scan, products: [products[0], source] }
    expect(cleanupGroupsPage(data, 'all', 'C3 4л', 0).rows).toHaveLength(1)
    expect(cleanupGroupsPage(data, 'all', '2000000000001', 0).rows).toHaveLength(1)
    expect(cleanupGroupsPage(data, 'review', 'ART-source', 0).rows).toHaveLength(0)
  })
  it('clamps pagination after filters shrink and never treats suggestions as selection', () => {
    expect(cleanupGroupsPage(scan, 'all', '', 20).page).toBe(0)
    expect(cleanupSelectionBlockers(scan, scan.groups[0], '', [])).toContain('Оберіть основну картку.')
    expect(cleanupSelectionBlockers(scan, scan.groups[0], 'target', [])).toContain('Позначте картки, які потрібно об’єднати з основною.')
  })
  it('blocks conflicts, missing rows, wrong selection and more than 20 sources', () => {
    expect(cleanupSelectionBlockers(scan, { ...scan.groups[0], level: 'conflict', conflicts: ['Різні бренди'] }, 'target', ['source'])).toContain('Різні бренди')
    expect(cleanupSelectionBlockers(scan, scan.groups[0], 'target', ['target'])).not.toEqual([])
    expect(cleanupSelectionBlockers(scan, scan.groups[0], 'target', ['other'])).not.toEqual([])
    expect(cleanupSelectionBlockers({ ...scan, products: [products[0]] }, scan.groups[0], 'target', ['source'])).not.toEqual([])
    expect(cleanupSelectionBlockers(scan, scan.groups[0], 'target', Array.from({ length: 21 }, (_, i) => String(i)))).not.toEqual([])
  })
  it('requires fresh matching preview, allows honest pending physical review and never sends quantity edits', () => {
    const input = cleanupApplyInput(preview, 'target', ['source'], 'Перевірено однакову оливу')
    expect(input).toEqual({ target_id: 'target', source_ids: ['source'], preview_fingerprint: 'preview-snapshot', stock_review: 'pending', reason: 'Перевірено однакову оливу' })
    expect(input).not.toHaveProperty('qty_on_hand')
    expect(() => cleanupApplyInput(preview, 'source', ['target'], 'Перевірено')).toThrow('змінився')
    expect(() => cleanupApplyInput({ ...preview, can_apply: false }, 'target', ['source'], 'Перевірено')).toThrow()
    expect(() => cleanupApplyInput({ ...preview, blockers: ['Відкрита накладна'] }, 'target', ['source'], 'Перевірено')).toThrow('Відкрита накладна')
    expect(() => cleanupApplyInput(preview, 'target', ['source'], '  ')).toThrow('причину')
  })
  it('preserves an identical operation ID on retries, never reuses it for another action', () => {
    const first = retainCleanupOperation(null, { source_ids: ['source'], target_id: 'target' }, () => 'op-1')
    const retry = retainCleanupOperation(first, { source_ids: ['source'], target_id: 'target' }, () => 'op-2')
    expect(retry).toBe(first)
    expect(retainCleanupOperation(first, { source_ids: ['other'], target_id: 'target' }, () => 'op-3').input.operation_id).toBe('op-3')
  })
  it('SKU apply uses only reviewed proposal, current field fingerprint, and cannot overwrite existing SKU', () => {
    const data = { ...scan, products: [{ ...products[0], sku: '' }] }
    const suggestion = { product_id: 'target', sku: '8206-1', evidence: 'Назва містить 8206-1', preview_fingerprint: 'sku-preview' }
    expect(cleanupSkuInput(data, suggestion)).toEqual({ product_id: 'target', sku: '8206-1', preview_fingerprint: 'sku-preview', reason: 'Назва містить 8206-1' })
    expect(cleanupSkuInput({ ...data, products: [{ ...products[0], sku: 'AUTO-0001' }] }, suggestion).sku).toBe('8206-1')
    expect(() => cleanupSkuInput(scan, suggestion)).toThrow('артикул')
    expect(() => cleanupSkuInput(data, { ...suggestion, blocked: 'Зайнятий код' })).toThrow('Зайнятий код')
    expect(() => cleanupSkuInput(data, { ...suggestion, evidence: '' })).toThrow('доказ')
  })
})
