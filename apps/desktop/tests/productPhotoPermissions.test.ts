import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'

describe('product photo lifecycle', () => {
  it.each(['owner', 'admin', 'manager', 'cashier', 'storekeeper'])('%s can save the card and its photo', (role) => {
    for (const action of ['save-product', 'save-photo', 'delete-photo']) {
      expect(isDesktopChannelAllowed('desktop:catalog:' + action, role)).toBe(true)
    }
  })
  it.each(['sto_viewer', 'tire_worker', 'unknown', ''])('%s cannot write photos', (role) => {
    expect(isDesktopChannelAllowed('desktop:catalog:save-photo', role)).toBe(false)
    expect(isDesktopChannelAllowed('desktop:catalog:delete-photo', role)).toBe(false)
  })
  it('does not grant cashier product deletion or settings changes', () => {
    expect(isDesktopChannelAllowed('desktop:catalog:delete-product', 'cashier')).toBe(false)
    expect(isDesktopChannelAllowed('desktop:catalog:update-settings', 'cashier')).toBe(false)
  })
  it('retains the saved photo after reopening the database, without changing stock', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'forsage-photo-test-'))
    let db = new LocalDatabase(root)
    try {
      const catalog = new LocalCatalogRepository(db)
      const base = { id: 'photo-test-product', sku: 'PHOTO-TEST', name: 'Фото товару', retail_price: 2500 }
      catalog.saveProduct({ ...base, qty_on_hand: 7 })
      catalog.saveProduct({ ...base, qty_on_hand: 999, photo_url: 'file:///C:/photos/test.jpg' })
      db.close()
      db = new LocalDatabase(root)
      const reopened = new LocalCatalogRepository(db)
      expect(reopened.findById(base.id)).toMatchObject({ photo_url: 'file:///C:/photos/test.jpg', qty_on_hand: 7 })
      reopened.saveProduct({ ...base, qty_on_hand: 0, photo_url: null })
      expect(reopened.findById(base.id)).toMatchObject({ photo_url: null, qty_on_hand: 7 })
    } finally {
      db.close()
      if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-photo-test-')) {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })
})
