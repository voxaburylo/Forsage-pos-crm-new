import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const customerOrders = read('../../routes/customerOrders.ts')
const chats = read('../../routes/chats.ts')
const saleService = read('../saleService.ts')
const aiService = read('../aiService.ts')
const telegramBot = read('../telegramBot.ts')
const importService = read('../importService.ts')
const onecImportService = read('../onecImportService.ts')
const productService = read('../productService.ts')
const seed = read('../../seed.ts')
const searchService = read('../searchService.ts')
const hybridSearch = read('../../routes/hybridSearch.ts')
const customerService = read('../customerService.ts')

function assertReferenceReadsAreActive(source: string, table: 'customer_cars' | 'customer_vehicles') {
  const marker = `.from('${table}')`
  let cursor = 0
  let readCount = 0
  while (true) {
    const start = source.indexOf(marker, cursor)
    if (start < 0) break
    const nextFrom = source.indexOf('.from(', start + marker.length)
    const block = source.slice(start, nextFrom < 0 ? source.length : nextFrom)
    const firstOperation = block.match(/\.(select|insert|update|delete)\s*\(/)?.[1]
    if (firstOperation === 'select') {
      readCount++
      expect(block, `${table} read at ${start} must exclude tombstones`).toContain(".is('deleted_at', null)")
    }
    cursor = start + marker.length
  }
  expect(readCount, `expected ${table} reads`).toBeGreaterThan(0)
}

describe('stale reference safety', () => {
  it('never reads soft-deleted customer vehicles in order, chat, sale, AI, or Telegram flows', () => {
    for (const source of [customerOrders, chats, saleService, aiService, telegramBot]) {
      assertReferenceReadsAreActive(source, 'customer_cars')
    }
    for (const source of [saleService, searchService, hybridSearch]) {
      assertReferenceReadsAreActive(source, 'customer_vehicles')
    }
  })

  it('soft-deletes both current and legacy customer garages with one database timestamp', () => {
    expect(customerService).toContain("for (const vehicleTable of ['customer_cars', 'customer_vehicles'])")
    expect(customerService).toContain("'SELECT clock_timestamp() AS deleted_at'")
    expect(customerService).toContain('SET deleted_at = $3, updated_at = $3')
  })

  it('soft-deletes Telegram cars with one timestamp instead of hard-deleting them', () => {
    expect(telegramBot).not.toContain("from('customer_cars').delete()")
    expect(telegramBot).toContain("update({ deleted_at: deletedAt, updated_at: deletedAt })")
  })

  it('only assigns active categories and brands during imports', () => {
    expect(importService).toMatch(/from\('categories'\)[\s\S]{0,160}is\('deleted_at', null\)/)
    expect(onecImportService).toMatch(/from\('categories'\)[\s\S]{0,160}is\('deleted_at', null\)/)
    expect(productService).toMatch(/from\('brands'\)[\s\S]{0,220}is\('deleted_at', null\)/)
    expect(aiService).toMatch(/from\('brands'\)[\s\S]{0,220}is\('deleted_at', null\)/)
  })

  it('creates active references explicitly and re-reads a concurrent winner', () => {
    for (const source of [importService, onecImportService, productService, aiService]) {
      expect(source).toContain('deleted_at: null')
    }
    expect(importService).toContain('concurrentCategory')
    expect(onecImportService).toContain('concurrentCategory')
    expect(productService).toContain('concurrentBrand')
    expect(aiService).toContain('concurrentBrand')
  })

  it('does not use an incompatible ON CONFLICT target for partial brand uniqueness in seed', () => {
    expect(seed).not.toContain("from('brands').upsert")
    expect(seed).toContain(".is('deleted_at', null)")
    expect(seed).toContain(".not('deleted_at', 'is', null)")
    expect(seed).toContain('if (deletedBrand) continue')
  })
})
