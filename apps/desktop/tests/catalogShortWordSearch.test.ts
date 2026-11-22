import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'

// Скарга власника 22.11.2026: «фанта ж/б» не знаходить «Фанта-Оранж 0,33 ж/б (12)».
// Однолітерні слова запиту («ж», «б») просто відкидались, і для запиту з одним довгим словом
// не лишалось жодного правила пошуку по словах.
let root: string, db: LocalDatabase, catalog: LocalCatalogRepository
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-short-word-'))
  db = new LocalDatabase(root)
  catalog = new LocalCatalogRepository(db)
  for (const product of [
    { id: 'can', sku: 'AI-51451B76', name: 'Фанта-Оранж 0,33 ж/б (12)', qty_on_hand: 0 },
    { id: 'can-tropic', sku: '5449000083135', name: 'Фанта Тропіканка 0.33 ж/б', qty_on_hand: 1 },
    { id: 'bottle', sku: 'AI-94CA71DB', name: 'Фанта-Оранж 0,5л. РО (12)', qty_on_hand: 0 },
    { id: 'cola-can', sku: 'AI-2E8422A3', name: 'Кока-кола 0,33 ж/б (12)', qty_on_hand: 0 },
    { id: 'oil', sku: 'OIL-1', name: 'Олива моторна 5W-40 1 л', qty_on_hand: 2 },
  ]) catalog.saveProduct({ ...product, unit: 'шт' })
})
afterEach(() => {
  db.close()
  if (path.dirname(path.resolve(root)) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-short-word-')) rmSync(root, { recursive: true, force: true })
})
const ids = (query: string) => catalog.listProducts({ query }).data.map(product => product.id).sort()
const quick = (query: string) => catalog.searchProducts(query, undefined, 20).map(product => product.id).sort()

it('finds «фанта ж/б» although the words stand apart in the name', () => {
  for (const query of ['фанта ж/б', 'Фанта ж б', 'фанта  жб'.replace('жб', 'ж/б'), 'ж/б фанта']) {
    expect(ids(query), query).toEqual(['can', 'can-tropic'])
    expect(quick(query), query).toEqual(['can', 'can-tropic'])
  }
})
it('short words narrow the result as whole words, never as a letter inside another word', () => {
  // «о» є всередині багатьох слів, але як окремого слова його немає в жодній назві.
  expect(ids('кола о')).toEqual([])
  // Набір запиту на ходу («фанта о…») лишається пошуком за початком фрази.
  expect(ids('фанта о')).toEqual(['bottle', 'can'])
  expect(ids('кола ж/б')).toEqual(['cola-can'])
  expect(ids('олива 1 л')).toEqual(['oil'])
  expect(ids('фанта 0,5л')).toEqual(['bottle'])
})
it('keeps ordinary searches as they were', () => {
  expect(ids('фанта')).toEqual(['bottle', 'can', 'can-tropic'])
  expect(ids('фанта оранж')).toEqual(['bottle', 'can'])
  expect(ids('5449000083135')).toEqual(['can-tropic'])
  expect(ids('ж/б')).toEqual(['can', 'can-tropic', 'cola-can'])
})
