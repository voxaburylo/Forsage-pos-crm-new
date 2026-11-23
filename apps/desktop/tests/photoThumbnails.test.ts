import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { MAX_THUMBNAIL_PRODUCTS, productPhotoThumbnails } from '../src/lib/photoThumbnails'
import { isLanProxyChannel } from '../src/lan/localNetwork'
import { webRpcChannelAllowed } from '../src/lan/webRpcChannels'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'

// 23.11.2026 (план 4.3): мініатюри для друкованого бланка замовлення — фото на касі лежать файлами,
// а file:-адреси не відкриваються ні у вебі, ні у вікні друку.
describe('product photo thumbnails for the printed order form', () => {
  let root: string, db: LocalDatabase, catalog: LocalCatalogRepository
  const shrink = (filePath: string) => 'data:image/png;base64,' + Buffer.from(path.basename(filePath)).toString('base64')
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-thumbs-'))
    db = new LocalDatabase(root)
    catalog = new LocalCatalogRepository(db)
    mkdirSync(path.join(root, 'photos', 'product'), { recursive: true })
    const inside = path.join(root, 'photos', 'product', 'a.jpg')
    writeFileSync(inside, 'x')
    const outside = path.join(root, 'secret.jpg')
    writeFileSync(outside, 'x')
    const product = (id: string, photo: string | null) => catalog.saveProduct({ id, sku: id.toUpperCase(), name: 'Product ' + id, qty_on_hand: 1, retail_price: 100, purchase_price: 50, photo_url: photo ?? undefined })
    product('a', pathToFileURL(inside).href)
    product('b', 'https://zuhanlspejgizjbwbnda.supabase.co/storage/v1/object/public/products/b.jpg')
    product('c', pathToFileURL(outside).href)
    product('d', null)
    product('e', 'http://example.com/e.jpg')
  })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })

  it('reads only photos the products point to, only from the photos folder', () => {
    const result = productPhotoThumbnails(db, root, ['a', 'b', 'c', 'd', 'e', 'missing'], shrink)
    expect(Object.keys(result).sort()).toEqual(['a', 'b'])
    expect(result.a).toBe(shrink('a.jpg'))
    expect(result.b).toMatch(/^https:\/\//)
  })

  it('refuses malformed input and caps the batch', () => {
    expect(() => productPhotoThumbnails(db, root, 'a', shrink)).toThrow('Вкажіть товари')
    expect(productPhotoThumbnails(db, root, [42, '../a', 'a'], shrink)).toEqual({ a: shrink('a.jpg') })
    let reads = 0
    productPhotoThumbnails(db, root, Array.from({ length: 200 }, () => 'a'), filePath => { reads++; return shrink(filePath) })
    expect(reads).toBe(1)
    expect(MAX_THUMBNAIL_PRODUCTS).toBe(60)
  })

  it('a broken or vanished photo is skipped, the form still prints', () => {
    expect(productPhotoThumbnails(db, root, ['a', 'b'], () => { throw new Error('broken') })).toEqual({ b: expect.stringMatching(/^https:/) })
    expect(productPhotoThumbnails(db, root, ['a'], () => 'javascript:alert(1)')).toEqual({})
    expect(productPhotoThumbnails(db, null, ['a', 'b'], shrink)).toEqual({ b: expect.stringMatching(/^https:/) })
  })

  it('the channel works in the till, on the manager PC and in the web through the main PC', () => {
    const channel = 'desktop:catalog:photo-thumbnails'
    expect(isDesktopChannelAllowed(channel, 'manager')).toBe(true)
    expect(isLanProxyChannel(channel)).toBe(true)
    expect(webRpcChannelAllowed(channel)).toBe(true)
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    expect(main).toContain("handleDesktopIpc('desktop:catalog:photo-thumbnails'")
    expect(main).toContain('image.resize({ width: 96 }).toDataURL()')
    expect(readFileSync(new URL('../src/desktopApi.ts', import.meta.url), 'utf8')).toContain("ipcRenderer.invoke('desktop:catalog:photo-thumbnails', productIds)")
  })
})
