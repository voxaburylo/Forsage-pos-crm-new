import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_TENANT_ID } from '../db/localTypes'

/** Скільки товарів за раз (бланк замовлення рідко має більше; більше — не читаємо). */
export const MAX_THUMBNAIL_PRODUCTS = 60

interface PhotoDatabase {
  prepare(sql: string): { all(...params: unknown[]): unknown[] }
}

/**
 * Мініатюри фото товарів для друкованого бланка замовлення (23.11.2026, план 4.3).
 * Фото на касі лежать файлами (file:), а такі адреси не відкриваються ні у вебі, ні у вікні друку — тому
 * головний ПК сам віддає зменшену картинку. Читає лише фото, на які посилаються самі товари, і лише з теки
 * photos цієї каси (жодних довільних шляхів). Відкрите фото з інтернету (https) віддає як є.
 */
export function productPhotoThumbnails(
  db: PhotoDatabase, dataRoot: string | null | undefined, productIds: unknown,
  thumbnail: (filePath: string) => string | null, tenantId = DEFAULT_TENANT_ID,
): Record<string, string> {
  if (!Array.isArray(productIds)) throw new Error('Вкажіть товари')
  const ids = [...new Set(productIds.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)))]
    .slice(0, MAX_THUMBNAIL_PRODUCTS)
  if (!ids.length) return {}
  const rows = db.prepare(`SELECT id, photo_url FROM products WHERE tenant_id = ? AND id IN (${ids.map(() => '?').join(',')})
    AND photo_url IS NOT NULL AND photo_url <> ''`).all(tenantId, ...ids) as Array<{ id: string; photo_url: string }>
  const photosRoot = dataRoot ? path.resolve(dataRoot, 'photos') : null
  const result: Record<string, string> = {}
  for (const row of rows) {
    const url = row.photo_url
    if (/^https:\/\/[^\s"'<>]{1,2000}$/i.test(url)) { result[row.id] = url; continue }
    if (!photosRoot || !url.startsWith('file:')) continue
    let filePath: string
    try { filePath = path.resolve(fileURLToPath(url)) } catch { continue }
    if (!filePath.startsWith(photosRoot + path.sep)) continue
    try {
      const data = thumbnail(filePath)
      if (data && /^data:image\/(png|jpeg|webp);base64,/.test(data)) result[row.id] = data
    } catch { /* фото зникло чи пошкоджене — бланк друкується без нього */ }
  }
  return result
}
