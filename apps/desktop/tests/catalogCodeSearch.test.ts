import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { codeSearchClauses, looseCode, queryAsCode } from '../src/repositories/catalogCodeSearch'

// 27.11.2026, слово власника: «не зрозуміло, чи працюють на касі всі крос-номери». На копії бази крос-номер знаходився
// лише набраний точно як у картці. У даних навмисно є літера «s» (правило про регулярні вирази).
describe('search by a code regardless of dashes, spaces, dots and slashes', () => {
  let root = '', db: LocalDatabase, catalog: LocalCatalogRepository
  const found = (query: string) => catalog.listProducts({ query, limit: 30 }).data.map(product => product.id).sort()

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-code-search-'))
    db = new LocalDatabase(root)
    catalog = new LocalCatalogRepository(db)
    catalog.upsertProduct({ id: 'mann', tenant_id: DEFAULT_TENANT_ID, sku: '77267', name: 'Фильтр масляный Accent/Cerato MAN W811/80', barcode: '4011558720001' })
    catalog.upsertProduct({ id: 'bosch', tenant_id: DEFAULT_TENANT_ID, sku: '0 986 452 036', name: 'Фільтр масляний Bosch s 1', barcode: '2000000000018' })
    catalog.upsertProduct({ id: 'pads', tenant_id: DEFAULT_TENANT_ID, sku: 'S-555', name: 'Колодки гальмівні передні s', barcode: '2000000000025' })
    catalog.changeCrossNumbers('mann', { add: ['26300-35500', 'OC 195', '13.0460-5899.2'], source: 'Картка товару' })
    catalog.changeCrossNumbers('pads', { add: ['025 239 7417'], source: 'Омега (кроси постачальника)' })
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-code-search-')) rmSync(root, { recursive: true, force: true })
  })

  it('finds a card by its cross number however it is typed', () => {
    for (const query of ['26300-35500', '2630035500', '26300 35500', '26300.35500']) expect(found(query), query).toEqual(['mann'])
    for (const query of ['OC 195', 'oc195', 'OC-195']) expect(found(query), query).toEqual(['mann'])
    for (const query of ['13.0460-5899.2', '13046058992']) expect(found(query), query).toEqual(['mann'])
    for (const query of ['025 239 7417', '0252397417', '025-239-7417']) expect(found(query), query).toEqual(['pads'])
  })

  it('finds a card by its article and by the article printed in the name', () => {
    for (const query of ['0 986 452 036', '0986452036', '0986-452-036']) expect(found(query), query).toEqual(['bosch'])
    for (const query of ['W811/80', 'w81180', 'W 811/80', 'w811-80']) expect(found(query), query).toEqual(['mann'])
    expect(found('s555')).toEqual(['pads'])
  })

  it('a wrong code finds nothing, and words are still searched as words', () => {
    expect(found('2630035501')).toEqual([])
    expect(found('0986452037')).toEqual([])
    expect(found('фільтр')).toEqual(['bosch', 'mann'])
    expect(found('фильтр масляный')).toEqual(['bosch', 'mann'])
    expect(found('колодки s')).toEqual(['pads'])
  })

  it('treats as a code only a query with a digit and without Cyrillic words', () => {
    expect(looseCode(' w 811/80-a.b_c ')).toBe('W81180ABC')
    expect(queryAsCode('26300 35500')).toBe('2630035500')
    expect(queryAsCode('фільтр w811')).toBeNull()
    expect(queryAsCode('bosch')).toBeNull()
    expect(queryAsCode('s-5')).toBeNull()
    expect(codeSearchClauses('фільтр', DEFAULT_TENANT_ID)).toEqual({ clauses: [], params: [] })
    // Короткий код (4 знаки) шукається лише як артикул і крос-номер, у тексті картки — від 5 знаків.
    expect(codeSearchClauses('s-555', DEFAULT_TENANT_ID).clauses).toHaveLength(2)
    expect(codeSearchClauses('s-5555', DEFAULT_TENANT_ID).params).toEqual(['S5555', DEFAULT_TENANT_ID, 'S5555', '%s5555%'])
  })
})
