import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({ api: { post: vi.fn() } }))
const { pickPhotoSearchProducts, initialPhotoSelection, base64ToBlob, PHOTO_SEARCH_MAX } = await import('./productPhotoSearch')

const product = (id: string, sku: string | null, photo_url: string | null = null) => ({ id, sku, name: 'Товар ' + id, photo_url })

describe('photo search from the catalog', () => {
  it('searches only products with an article, products without a photo first, at most 8', () => {
    const products = [product('a', 'WA6684', 'file:///x.jpg'), product('b', null), product('c', 'H7'), ...Array.from({ length: 9 }, (_, i) => product('n' + i, 'ART-' + i + '000'))]
    const picked = pickPhotoSearchProducts(products)
    expect(picked.search).toHaveLength(PHOTO_SEARCH_MAX)
    expect(picked.search[0].id).toBe('n0')
    expect(picked.search.some(item => item.id === 'a')).toBe(false)
    expect(picked.skippedNoSku).toBe(2)
    expect(picked.skippedOverLimit).toBe(2)
  })

  it('pre-selects found photos only for products that have none', () => {
    const products = [product('a', 'WA6684', 'file:///x.jpg'), product('b', 'WA6685')]
    const results = [
      { product_id: 'a', status: 'found' as const, reason: '', image_base64: 'AA==', mime_type: 'image/jpeg' },
      { product_id: 'b', status: 'found' as const, reason: '', image_base64: 'AA==', mime_type: 'image/jpeg' },
      { product_id: 'c', status: 'not_found' as const, reason: '' },
    ]
    expect([...initialPhotoSelection(results, products)]).toEqual(['b'])
  })

  it('turns the returned image back into bytes', async () => {
    const blob = base64ToBlob(Buffer.from([0xff, 0xd8, 0xff, 1]).toString('base64'), 'image/jpeg')
    expect(blob.type).toBe('image/jpeg')
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([0xff, 0xd8, 0xff, 1])
  })
})
