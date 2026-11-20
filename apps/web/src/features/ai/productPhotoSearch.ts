import { api } from '@/lib/api'

export const PHOTO_SEARCH_MAX = 8

export interface PhotoSearchProduct { id: string; sku: string | null; name: string; brand?: string | null; photo_url?: string | null }
export interface PhotoSearchResult {
  product_id: string
  status: 'found' | 'not_found'
  reason: string
  page_url?: string
  image_url?: string
  mime_type?: string
  image_base64?: string
}

export function findProductPhotos(products: PhotoSearchProduct[]) {
  return api.post<{ data: { results: PhotoSearchResult[]; usage: { cost_usd_estimate: number } } }>(
    '/api/v1/ai/product-photos',
    { products: products.slice(0, PHOTO_SEARCH_MAX).map(({ id, sku, name, brand }) => ({ id, sku, name, brand: brand ?? null })) },
    undefined,
    { timeoutMs: 280_000, silent: true },
  )
}

/** Для пошуку беремо лише товари з артикулом (без нього точний збіг неможливий); спершу — без фото. */
export function pickPhotoSearchProducts(products: PhotoSearchProduct[]): { search: PhotoSearchProduct[]; skippedNoSku: number; skippedOverLimit: number } {
  const withSku = products.filter(product => (product.sku ?? '').replace(/[\s\-._/]/g, '').length >= 4)
  const ordered = [...withSku.filter(product => !product.photo_url), ...withSku.filter(product => product.photo_url)]
  return { search: ordered.slice(0, PHOTO_SEARCH_MAX), skippedNoSku: products.length - withSku.length, skippedOverLimit: Math.max(0, ordered.length - PHOTO_SEARCH_MAX) }
}

/** Знайдене фото відмічене одразу лише для товару без фото; заміну існуючого фото власник вмикає сам. */
export function initialPhotoSelection(results: PhotoSearchResult[], products: PhotoSearchProduct[]): Set<string> {
  const hasPhoto = new Set(products.filter(product => product.photo_url).map(product => product.id))
  return new Set(results.filter(result => result.status === 'found' && result.image_base64 && !hasPhoto.has(result.product_id)).map(result => result.product_id))
}

export function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: mime })
}
