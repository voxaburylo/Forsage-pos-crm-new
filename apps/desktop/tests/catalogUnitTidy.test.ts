import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { pendingUnitSpellings, tidyUnitSpellings } from '../src/repositories/catalogUnitTidy'

describe('unit spellings are unified automatically (owner, 20.11.2026)', () => {
  let root: string, db: LocalDatabase, catalog: LocalCatalogRepository
  const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'forsage-unit-tidy-')); db = new LocalDatabase(root); catalog = new LocalCatalogRepository(db) })
  afterEach(() => { db.close(); if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-unit-tidy-')) rmSync(root, { recursive: true, force: true }) })

  it('changes only the spelling; stock, prices and unknown units stay; a second run changes nothing', () => {
    const units = ['ШТ', 'шт.', 'Штука', 'од.', 'К-Т', 'КОМ-Т', 'Комплект', 'Пара', 'уп', 'упаков', 'мл', 'шт', 'бухта']
    units.forEach((unit, n) => catalog.saveProduct({ id: id(n + 1), sku: 'U-' + n, name: 'Товар ' + n, unit, qty_on_hand: n, purchase_price: 100, retail_price: 20000 }))
    expect(pendingUnitSpellings(db)).toBe(10)
    expect(tidyUnitSpellings(db)).toBe(10)
    const rows = units.map((_, n) => db.prepare('SELECT unit, qty_on_hand, retail_price, purchase_price FROM products WHERE id=?').get(id(n + 1)) as Record<string, unknown>)
    expect(rows.map(row => row.unit)).toEqual(['шт', 'шт', 'шт', 'шт', 'компл', 'компл', 'компл', 'компл', 'упак', 'упак', 'мл', 'шт', 'бухта'])
    expect(rows.map(row => row.qty_on_hand)).toEqual(units.map((_, n) => n))
    expect(rows.every(row => row.retail_price === 20000 && row.purchase_price === 100)).toBe(true)
    expect((db.prepare("SELECT count(*) n FROM audit_log WHERE action='catalog.unit_tidy'").get() as { n: number }).n).toBe(10)
    expect(pendingUnitSpellings(db)).toBe(0)
    expect(tidyUnitSpellings(db)).toBe(0)
  })
})
