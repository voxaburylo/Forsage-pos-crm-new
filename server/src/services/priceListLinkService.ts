import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { pool } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'

/**
 * Прайс для клієнта за посиланням. Клієнт бачить лише вибрані товари: назву, артикул, бренд,
 * ціну продажу (зі знижкою посилання, але НІКОЛИ не нижче закупки) і чи є товар у наявності.
 * Закупка, залишки в штуках і будь-що інше не віддається.
 */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/

export const createPriceLinkSchema = z.object({
  title: z.string().trim().min(1).max(120),
  product_ids: z.array(z.string().uuid()).min(1).max(500),
  discount_pct: z.number().min(0).max(50).default(0),
  expires_days: z.number().int().min(1).max(90).default(14),
  show_stock: z.boolean().default(true),
}).strict()

export function newPriceLinkToken(): string {
  return randomBytes(24).toString('base64url')
}

/** Ціна для клієнта в копійках: знижка посилання, округлення вгору до гривні, але не нижче закупки. */
export function clientPrice(retail: number, purchase: number, discountPct: number): number {
  const discounted = Math.ceil((retail * (100 - discountPct)) / 100 / 100) * 100
  return Math.max(discounted, purchase > 0 ? purchase : 0, 0)
}

export async function createPriceLink(tenantId: string, userId: string, input: z.infer<typeof createPriceLinkSchema>) {
  const ids = [...new Set(input.product_ids)]
  const token = newPriceLinkToken()
  const { rows } = await pool.query(
    `INSERT INTO price_list_links (tenant_id, token, title, product_ids, discount_pct, show_stock, created_by, expires_at)
     VALUES ($1, $2, $3, $4::uuid[], $5, $6, $7, now() + make_interval(days => $8))
     RETURNING id, token, title, discount_pct, show_stock, created_at, expires_at, cardinality(product_ids) AS items`,
    [tenantId, token, input.title, ids, input.discount_pct, input.show_stock, userId, input.expires_days],
  )
  return publicLinkRow(rows[0])
}

export async function listPriceLinks(tenantId: string) {
  const { rows } = await pool.query(
    `SELECT id, token, title, discount_pct, show_stock, created_at, expires_at, revoked_at, cardinality(product_ids) AS items
       FROM price_list_links WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [tenantId],
  )
  return rows.map(publicLinkRow)
}

export async function revokePriceLink(tenantId: string, id: string) {
  const { rowCount } = await pool.query(
    'UPDATE price_list_links SET revoked_at = now() WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL',
    [tenantId, id],
  )
  if (!rowCount) throw new AppError('NOT_FOUND', 'Посилання не знайдено або вже вимкнено', 404)
  return { revoked: true }
}

function publicLinkRow(row: any) {
  return {
    id: row.id, token: row.token, title: row.title, discount_pct: Number(row.discount_pct) || 0,
    show_stock: Boolean(row.show_stock), items: Number(row.items) || 0,
    created_at: new Date(row.created_at).toISOString(), expires_at: new Date(row.expires_at).toISOString(),
    revoked_at: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  }
}

/** Публічний перегляд за токеном. Невідомий, прострочений чи вимкнений токен — однакова відповідь «не знайдено». */
export async function readPublicPriceList(token: string) {
  if (!TOKEN_PATTERN.test(token)) throw notFound()
  const link = (await pool.query(
    `SELECT l.tenant_id, l.title, l.product_ids, l.discount_pct, l.show_stock, l.created_at, l.expires_at,
            s.shop_name, s.phone, s.shop_address
       FROM price_list_links l LEFT JOIN shop_settings s ON s.tenant_id = l.tenant_id
      WHERE l.token = $1 AND l.revoked_at IS NULL AND l.expires_at > now()`,
    [token],
  )).rows[0]
  if (!link) throw notFound()
  const discount = Number(link.discount_pct) || 0
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.sku, b.name AS brand, p.retail_price, p.purchase_price, p.qty_on_hand::float8 AS qty, p.photo_url
       FROM products p LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1 AND p.id = ANY($2::uuid[]) AND p.deleted_at IS NULL AND p.is_active
      ORDER BY p.name`,
    [link.tenant_id, link.product_ids],
  )
  return {
    title: link.title,
    shop: { name: link.shop_name ?? null, phone: link.phone ?? null, address: link.shop_address ?? null },
    discount_pct: discount,
    created_at: new Date(link.created_at).toISOString(),
    expires_at: new Date(link.expires_at).toISOString(),
    items: rows.map((row: any) => ({
      id: row.id, name: row.name, sku: row.sku ?? null, brand: row.brand ?? null,
      photo_url: typeof row.photo_url === 'string' && /^https:\/\//.test(row.photo_url) ? row.photo_url : null,
      price: clientPrice(Number(row.retail_price) || 0, Number(row.purchase_price) || 0, discount),
      ...(link.show_stock ? { in_stock: Number(row.qty) > 0 } : {}),
    })),
  }
}

function notFound() {
  return new AppError('NOT_FOUND', 'Прайс не знайдено або термін його дії минув', 404)
}
