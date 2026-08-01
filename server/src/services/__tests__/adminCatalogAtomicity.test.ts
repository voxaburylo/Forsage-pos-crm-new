import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../adminService.ts', import.meta.url), 'utf8')

function functionSource(name: string, nextMarker: string): string {
  const start = source.indexOf(`export async function ${name}`)
  const end = source.indexOf(nextMarker, start)
  return source.slice(start, end)
}

describe('catalog administration atomicity', () => {
  it('soft-deletes a category and all dependent updates in one transaction', () => {
    const body = functionSource('deleteCategory', '// ????? ???????? ????????')
    expect(body).toContain('await runTransaction(async (client) =>')
    expect(body).toContain('FOR UPDATE')
    expect(body).toContain('LOCK TABLE brands, categories, products')
    expect(body).toContain('deleted_at = $3, updated_at = $3')
    expect(body.indexOf('clearCatalogReferenceCaches')).toBeGreaterThan(body.indexOf('await runTransaction'))
    expect(body.indexOf('clearProductSearchCache')).toBeGreaterThan(body.indexOf('await runTransaction'))
  })

  it('resets products and categories atomically with one database timestamp', () => {
    const body = functionSource('resetCatalog', '// ===================== BRANDS')
    expect(body).toContain('await runTransaction(async (client) =>')
    expect(body).toContain('SELECT clock_timestamp() AS at')
    expect(body).toContain('UPDATE products SET deleted_at = $2')
    expect(body).toContain('UPDATE categories SET deleted_at = $2')
  })

  it('soft-deletes a brand and clears product references atomically', () => {
    const body = functionSource('deleteBrand', '// ===================== SETTINGS')
    expect(body).toContain('await runTransaction(async (client) =>')
    expect(body).toContain('FOR UPDATE')
    expect(body).toContain('UPDATE products SET brand_id = NULL')
    expect(body).toContain('UPDATE brands SET deleted_at = $3')
  })
})
