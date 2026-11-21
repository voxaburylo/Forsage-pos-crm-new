import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'

let root: string, db: LocalDatabase, catalog: LocalCatalogRepository
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'forsage-negative-')); db = new LocalDatabase(root); catalog = new LocalCatalogRepository(db) })
afterEach(() => { db.close(); if (path.basename(root).startsWith('forsage-negative-')) rmSync(root, { recursive: true, force: true }) })

it('lists only goods sold below zero, worst first, and drops them once stock is back', () => {
  catalog.upsertProduct({ id: 'a', name: 'Хомут', sku: 'H1', qty_on_hand: -1 })
  catalog.upsertProduct({ id: 'b', name: 'Фільтр', sku: 'F1', qty_on_hand: -3 })
  catalog.upsertProduct({ id: 'c', name: 'Масло', sku: 'M1', qty_on_hand: 4 })
  catalog.upsertProduct({ id: 'd', name: 'Видалений', sku: 'D1', qty_on_hand: -2 })
  db.prepare('UPDATE products SET deleted_at = ? WHERE id = ?').run('2026-11-01', 'd')
  expect(catalog.listNegativeStock().map(row => [row.id, row.qty_on_hand])).toEqual([['b', -3], ['a', -1]])
  db.prepare('UPDATE products SET qty_on_hand = 0 WHERE id = ?').run('b')
  expect(catalog.listNegativeStock().map(row => row.id)).toEqual(['a'])
})
