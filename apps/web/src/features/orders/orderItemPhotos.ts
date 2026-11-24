import { useEffect, useState } from 'react'
import { desktopBridge } from '@/lib/desktopBridge'

/**
 * 24.11.2026 (план C2): мініатюри позицій замовлення (вирізані зі скриншота кошика чи взяті з довідника).
 * Зберігає їх головний ПК; веб бачить через нього. Без звʼязку — просто без мініатюр.
 */
const cache = new Map<string, Record<string, string>>()

export async function readOrderItemPhotos(orderId: string | null | undefined): Promise<Record<string, string>> {
  const read = desktopBridge()?.orders?.itemPhotos
  if (!orderId || !read) return {}
  try {
    const photos = await read(orderId)
    const clean = Object.fromEntries(Object.entries(photos ?? {}).filter(([, url]) => typeof url === 'string' && url.startsWith('data:image/')))
    cache.set(orderId, clean)
    return clean
  } catch { return cache.get(orderId) ?? {} }
}

export function useOrderItemPhotos(orderId: string | null | undefined, revision: unknown = null): Record<string, string> {
  const [photos, setPhotos] = useState<Record<string, string>>(() => (orderId ? cache.get(orderId) : undefined) ?? {})
  useEffect(() => {
    let alive = true
    setPhotos((orderId ? cache.get(orderId) : undefined) ?? {})
    void readOrderItemPhotos(orderId).then(found => { if (alive) setPhotos(found) })
    return () => { alive = false }
  }, [orderId, revision])
  return photos
}

/** Для друку бланка: мініатюри позицій під ключем «item:<позиція>», поруч із фото карток товарів. */
export function itemPhotoThumbnails(photos: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(photos).map(([itemId, url]) => ['item:' + itemId, url]))
}
