import type { EnrichedCustomerOrder, EnrichedOrderItem } from './pickingApi'

/**
 * 24.11.2026 (слово власника): «у збірку замовлень — сканувати штрихкод прибулого товару, за бажанням, щоб не заважало;
 * коли наростимо базу штрихкодів, буде швидко розкидати замовлення по комірках сканером».
 * Відсканували товар — програма каже, для якого він замовлення і в яку комірку покласти, і відмічає позицію «надійшло».
 * Код порівнюється зі штрихкодом картки (через знайдені картки) і з артикулом позиції. Нічого не вгадуємо: немає
 * точного збігу — так і кажемо.
 */
const code = (value: unknown) => String(value ?? '').normalize('NFKC').toUpperCase().replace(/[^A-ZА-ЯІЇЄҐ0-9]/g, '')
/** Позиція ще чекає: не прибула, не видана, не скасована. */
const waiting = (item: EnrichedOrderItem) => item.item_status === 'pending' || item.item_status === 'ordered'

export interface ScanTarget { order: EnrichedCustomerOrder; item: EnrichedOrderItem; moreWaiting: number }

/**
 * Для якого замовлення цей товар. productIds — картки, чий штрихкод або артикул ТОЧНО дорівнює відсканованому.
 * Якщо товару чекає кілька замовлень — найстаріше; moreWaiting — скільки ще позицій чекає на такий самий товар.
 */
export function findScanTarget(orders: EnrichedCustomerOrder[], scanned: string, productIds: readonly string[]): ScanTarget | null {
  const wanted = code(scanned)
  if (wanted.length < 3) return null
  const ids = new Set(productIds)
  const hits: Array<{ order: EnrichedCustomerOrder; item: EnrichedOrderItem }> = []
  for (const order of orders) for (const item of order.items) {
    if (!waiting(item)) continue
    if ((item.product_id && ids.has(item.product_id)) || (item.sku && code(item.sku) === wanted)) hits.push({ order, item })
  }
  if (!hits.length) return null
  hits.sort((a, b) => String(a.order.created_at ?? '').localeCompare(String(b.order.created_at ?? '')))
  return { ...hits[0], moreWaiting: hits.length - 1 }
}

/** Картки, які точно відповідають коду: основний чи додатковий штрихкод або артикул. Схожі не беремо. */
export function exactScanProducts(scanned: string, found: Array<{ id: string; sku?: string | null; barcode?: string | null; additional_barcodes?: unknown }>): string[] {
  const wanted = code(scanned)
  if (!wanted) return []
  return found.filter(product => code(product.sku) === wanted || code(product.barcode) === wanted
    || (Array.isArray(product.additional_barcodes) && product.additional_barcodes.some(extra => code(extra) === wanted))).map(product => product.id)
}

/** Що сказати комірнику після сканування. */
export function scanResultText(target: ScanTarget): { title: string; where: string; more: string } {
  const number = (target.order as { order_number?: unknown }).order_number
  const customer = target.order.customer?.full_name || target.order.customer?.phone || 'клієнт без імені'
  return {
    title: `${target.item.name} — ${Number(target.item.qty)} шт`,
    where: `Замовлення${number ? ' № ' + String(number) : ''} · ${customer}`,
    more: target.moreWaiting > 0 ? `Цей товар чекає ще ${target.moreWaiting} поз. в інших замовленнях — відскануйте наступну штуку.` : '',
  }
}
