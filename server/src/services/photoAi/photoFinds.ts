import { z } from 'zod'
import { pool } from '../../db/pg.js'
import { AppError } from '../../middleware/errorHandler.js'
import { PhotoAiLater, PhotoAiStop, CARD_TOP, type PhotoProduct } from './photoSearch.js'
import { addUsage, readKeys, readSettings, type PhotoCalls } from './photoAiConfig.js'
import { findPhotos, type CheckedPhoto, type FinderDeps } from './photoFinder.js'
import { downloadImage, isAiPhotoUrl, removeStored, storePhoto, type StoreDeps } from './photoStore.js'

/**
 * «Пошук фото з ШІ»: знайдені фото — від перевірки до картки товару.
 * Стани: pending (чекає людини) → approved (можна ставити) → applied (стоїть у картці); rejected; skipped (у картці вже
 * було своє фото — ручні фото автоматичними не замінюємо).
 * Адресу головного фото в картку ставить головний ПК (каса — головна база); сервер у товари каси нічого не пише.
 * Галерея (решта вибраних фото) — таблиця product_photos у хмарі: її бачить сайт, у касі її немає.
 */
const uuid = z.string().uuid()
export const productSchema = z.object({ id: uuid, name: z.string().trim().min(1).max(500), sku: z.string().max(200).nullish(), brand: z.string().max(200).nullish() })
export const searchSchema = z.object({ product: productSchema })
export const saveSchema = z.object({ product: productSchema, urls: z.array(z.string().url().max(1500)).min(1).max(5) })
export const decideSchema = z.object({ product_id: uuid, approve: z.array(uuid).max(5) })
export const appliedSchema = z.object({ applied: z.array(uuid).max(200).default([]), skipped: z.array(uuid).max(200).default([]) })
export const SEARCH_AGAIN_DAYS = 30

export type FindDeps = FinderDeps & StoreDeps

/** Те, що бачить людина: без байтів картинки. */
export const publicPhoto = ({ bytes: _bytes, ...photo }: CheckedPhoto) => photo

export function stopError(error: unknown): AppError | null {
  if (error instanceof PhotoAiStop) return new AppError(error.reason === 'serper_credits' ? 'PHOTO_AI_NO_CREDITS' : 'PHOTO_AI_NOT_READY', error.message, 400)
  if (error instanceof PhotoAiLater) return new AppError('PHOTO_AI_BUSY', error.message + '. Спробуйте за хвилину.', 503)
  return null
}

export async function rememberSearch(tenantId: string, productId: string, found: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO photo_ai_searches (tenant_id, product_id, searched_at, found) VALUES ($1, $2, now(), $3)
     ON CONFLICT (tenant_id, product_id) DO UPDATE SET searched_at = now(), found = EXCLUDED.found`, [tenantId, productId, found])
}

/** Кнопка «Знайти фото (ШІ)» у картці: до 8 варіантів з відміткою ШІ. Нічого не зберігає. */
export async function searchForCard(tenantId: string, product: PhotoProduct, deps: FindDeps = {}) {
  const [settings, keys] = await Promise.all([readSettings(tenantId), readKeys(tenantId)])
  const calls: PhotoCalls = { serper: 0, gemini: 0 }
  try {
    const checked = await findPhotos(product, settings, keys, calls, { top: CARD_TOP, need: null }, deps, AbortSignal.timeout(50_000))
    await rememberSearch(tenantId, product.id, checked.some(photo => photo.ok))
    return { photos: checked.map(publicPhoto), calls, per_product: settings.photos_per_product }
  } catch (error) { throw stopError(error) ?? error }
  finally { await addUsage(tenantId, calls).catch(() => undefined) }
}

/** Попередні «не поставлені» знахідки товару більше не потрібні: відхиляємо й прибираємо файли. */
async function dropOpenFinds(tenantId: string, productId: string, keepUrls: string[], deps: StoreDeps): Promise<void> {
  const { rows } = await pool.query(
    `UPDATE photo_ai_finds SET state = 'rejected', decided_at = now()
      WHERE tenant_id = $1 AND product_id = $2 AND state IN ('pending', 'approved') AND NOT (url = ANY($3::text[])) RETURNING url`, [tenantId, productId, keepUrls])
  await removeStored(tenantId, rows.map((row: { url: string }) => row.url), deps)
}

/**
 * «Зберегти» в картці: вибрані людиною фото (перше — головне) завантажуються, стискаються й лягають у наше сховище.
 * Повертає адресу головного — її в картку ставить програма на головному ПК.
 */
export async function saveChosen(tenantId: string, product: PhotoProduct, urls: string[], deps: FindDeps = {}) {
  const stored: Array<{ url: string; thumb_url: string; source: string }> = []
  for (const source of [...new Set(urls)]) {
    const image = await (deps.download ?? downloadImage)(source)
    if (!image) continue
    try { stored.push({ ...(await storePhoto(tenantId, product.id, image.bytes, deps)), source }) } catch { /* це фото пропускаємо, решту зберігаємо */ }
  }
  if (!stored.length) throw new AppError('PHOTO_AI_SAVE_FAILED', 'Жодне з вибраних фото не вдалося зберегти: сайт-джерело не віддав картинку. Виберіть інші.', 502)
  await dropOpenFinds(tenantId, product.id, stored.map(photo => photo.url), deps)
  for (const [position, photo] of stored.entries()) {
    await pool.query(
      `INSERT INTO photo_ai_finds (tenant_id, product_id, position, url, thumb_url, source_url, product_name, state, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', now())`, [tenantId, product.id, position, photo.url, photo.thumb_url, photo.source, product.name])
  }
  await rememberSearch(tenantId, product.id, true)
  return { main_url: stored[0].url, saved: stored.length, asked: urls.length }
}

/** Масовий режим «на перевірку»: товари зі знайденими фото, що чекають людини. */
export async function listReview(tenantId: string, limit = 30) {
  const { rows } = await pool.query(
    `SELECT f.id, f.product_id, f.position, f.url, f.thumb_url, f.source_page, f.product_name, f.created_at,
            count(*) OVER (PARTITION BY f.product_id) AS photos
       FROM photo_ai_finds f
      WHERE f.tenant_id = $1 AND f.state = 'pending'
        AND f.product_id IN (SELECT product_id FROM photo_ai_finds WHERE tenant_id = $1 AND state = 'pending' GROUP BY product_id ORDER BY min(created_at) LIMIT $2)
      ORDER BY f.created_at, f.product_id, f.position`, [tenantId, limit])
  const products = new Map<string, { product_id: string; name: string; photos: Array<{ id: string; url: string; thumb_url: string; source_page: string | null }> }>()
  for (const row of rows) {
    const entry = products.get(row.product_id) ?? { product_id: row.product_id as string, name: String(row.product_name ?? ''), photos: [] as Array<{ id: string; url: string; thumb_url: string; source_page: string | null }> }
    entry.photos.push({ id: row.id, url: row.url, thumb_url: row.thumb_url, source_page: row.source_page })
    products.set(row.product_id, entry)
  }
  const waiting = Number((await pool.query("SELECT count(DISTINCT product_id)::int AS n FROM photo_ai_finds WHERE tenant_id = $1 AND state = 'pending'", [tenantId])).rows[0]?.n) || 0
  return { products: [...products.values()], waiting }
}

/** Рішення людини по товару: відмічені (у цьому порядку; перше — головне) — approved, решта — rejected. */
export async function decide(tenantId: string, input: z.infer<typeof decideSchema>, deps: StoreDeps = {}) {
  const { rows } = await pool.query("SELECT id, url FROM photo_ai_finds WHERE tenant_id = $1 AND product_id = $2 AND state = 'pending'", [tenantId, input.product_id])
  const pending = new Map<string, string>(rows.map((row: { id: string; url: string }) => [row.id, row.url]))
  const approve = [...new Set(input.approve)].filter(id => pending.has(id))
  for (const [position, id] of approve.entries()) {
    await pool.query("UPDATE photo_ai_finds SET state = 'approved', position = $3, decided_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, id, position])
  }
  const rejected = [...pending.keys()].filter(id => !approve.includes(id))
  if (rejected.length) {
    await pool.query("UPDATE photo_ai_finds SET state = 'rejected', decided_at = now() WHERE tenant_id = $1 AND id = ANY($2::uuid[])", [tenantId, rejected])
    await removeStored(tenantId, rejected.map(id => pending.get(id)!), deps)
  }
  // Нічого не підійшло — не шукаємо цей товар знову 30 днів.
  if (!approve.length) await rememberSearch(tenantId, input.product_id, false)
  return { approved: approve.length, rejected: rejected.length }
}

/** Головні фото, які вже можна ставити в картки (їх забирає головний ПК). */
export async function listUnapplied(tenantId: string, limit = 200) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (product_id) product_id, url FROM photo_ai_finds
      WHERE tenant_id = $1 AND state = 'approved' ORDER BY product_id, position, created_at LIMIT $2`, [tenantId, limit])
  return rows.map((row: { product_id: string; url: string }) => ({ product_id: row.product_id, url: row.url }))
}

/**
 * Головний ПК доповів: у ці картки фото поставлено (applied), а в цих уже було своє фото (skipped).
 * Для поставлених решта вибраних фото стає галереєю в хмарі (product_photos) — її бачить сайт.
 */
export async function markApplied(tenantId: string, input: z.infer<typeof appliedSchema>, deps: StoreDeps = {}) {
  let applied = 0, skipped = 0
  for (const productId of [...new Set(input.applied)]) {
    const { rows } = await pool.query(
      "UPDATE photo_ai_finds SET state = 'applied', decided_at = now() WHERE tenant_id = $1 AND product_id = $2 AND state = 'approved' RETURNING url, position", [tenantId, productId])
    if (!rows.length) continue
    applied += 1
    const gallery = (rows as Array<{ url: string; position: number }>).sort((a, b) => a.position - b.position).slice(1)
    // Галерею попереднього пошуку цього товару замінюємо новою; чужих (не наших) фото в галереї не чіпаємо.
    await pool.query(`DELETE FROM product_photos ph USING products p WHERE ph.product_id = p.id AND p.tenant_id = $1 AND p.id = $2 AND ph.url LIKE '%/product-photos/ai/%'`, [tenantId, productId])
    for (const [index, photo] of gallery.entries()) {
      await pool.query(
        `INSERT INTO product_photos (product_id, url, sort_order) SELECT p.id, $3, $4 FROM products p WHERE p.id = $2 AND p.tenant_id = $1`, [tenantId, productId, photo.url, index + 1])
    }
  }
  for (const productId of [...new Set(input.skipped)]) {
    const { rows } = await pool.query(
      "UPDATE photo_ai_finds SET state = 'skipped', decided_at = now() WHERE tenant_id = $1 AND product_id = $2 AND state = 'approved' RETURNING url", [tenantId, productId])
    if (!rows.length) continue
    skipped += 1
    await removeStored(tenantId, rows.map((row: { url: string }) => row.url).filter(isAiPhotoUrl), deps)
  }
  return { applied, skipped }
}
