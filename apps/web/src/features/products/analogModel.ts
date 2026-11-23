import type { Product } from '@/types/product'
import { normalizeAnalogs } from '@/features/pos/analogLookup'

/**
 * 23.11.2026 (план B1b, слово власника): «подивитись аналоги я можу тільки в касі; у товарах — лише картка».
 * Аналоги в «Товарах»: кнопка в списку й блок у картці, із залишком, ціною та кнопками «у чек» / «у замовлення».
 * Аналог — товар зі складу, у якого збігається цілий крос-номер (не шматок номера).
 */
export function analogRows(sourceId: string, response: unknown): Product[] {
  const body = response as { analogs?: unknown; data?: unknown } | unknown[] | null | undefined
  const list = Array.isArray(body) ? body : Array.isArray(body?.analogs) ? body.analogs : Array.isArray(body?.data) ? body.data : []
  return normalizeAnalogs(sourceId, (list as Product[]).filter(row => row && typeof row.id === 'string' && typeof row.name === 'string'))
}

export const analogStock = (product: Pick<Product, 'qty_on_hand' | 'qty_available'>): number =>
  Number(product.qty_available ?? product.qty_on_hand) || 0

/** Скільки аналогів є на складі зараз (для підпису кнопки). */
export const analogsInStock = (rows: Product[]): number => rows.filter(row => analogStock(row) > 0).length

const RECEIPT_ROLES = ['owner', 'admin', 'manager', 'cashier']
const ORDER_ROLES = ['owner', 'admin', 'manager']

/** «У чек» — лише в програмі на касі (продаж із вебу закрито); «у замовлення» — хто веде замовлення. */
export function analogActions(role: string, desktop: boolean): { receipt: boolean; order: boolean } {
  return { receipt: desktop && RECEIPT_ROLES.includes(role), order: ORDER_ROLES.includes(role) }
}

/** Каса сама додає товар звичним шляхом (ціна, знижки, перевірка закупки) — тут лише адреса. */
export const analogReceiptPath = (productId: string) => `/pos?add=${encodeURIComponent(productId)}`
export const analogOrderPath = (productId: string) => `/orders/new?product=${encodeURIComponent(productId)}`

/** Ідентифікатор товару з адреси: лише безпечні символи, інакше нічого не додаємо. */
export function productIdFromParam(value: string | null | undefined): string | null {
  const id = String(value ?? '').trim()
  return /^[A-Za-z0-9-]{1,128}$/.test(id) ? id : null
}
