import { useEffect, useState } from 'react'
import { desktopBridge } from '@/lib/desktopBridge'
import { formatMoney } from '@/lib/utils'
import { useOrderItemPhotos } from '@/features/orders/orderItemPhotos'

export interface HandoverItem { id: string; product_id: string | null; sku: string | null; name: string; sell_price: number; qty: number; item_status: string; source_type?: 'warehouse' | 'supplier' }
export interface HandoverRow { id: string; productId: string | null; name: string; sku: string; qty: number; total: number; state: 'here' | 'waiting' | 'handed' }

const STATE_LABEL: Record<HandoverRow['state'], string> = { here: 'на місці', waiting: 'ще не прибуло', handed: 'видано' }
const STATE_COLOR: Record<HandoverRow['state'], string> = { here: 'text-green-400', waiting: 'text-orange-400', handed: 'text-gray-500' }

/**
 * Позиції замовлення для видачі (етап 5, рішення власника 22.11.2026: видача з фото).
 * Скасовані й повернені позиції не показуємо; «на місці» — те, що прибуло від постачальника або береться зі складу.
 */
export function handoverRows(items: readonly HandoverItem[]): HandoverRow[] {
  return items.filter(item => item.item_status !== 'canceled' && item.item_status !== 'returned').map(item => ({
    id: item.id, productId: item.product_id || null, name: item.name, sku: item.sku ?? '',
    qty: Number(item.qty) || 0, total: Math.round((Number(item.sell_price) || 0) * (Number(item.qty) || 0)),
    state: item.item_status === 'handed' ? 'handed'
      : item.item_status === 'arrived' || (item.source_type === 'warehouse' && item.item_status === 'pending') ? 'here' : 'waiting',
  }))
}

// Фото картки товару читаємо з бази каси один раз на сесію вікна; відсутність фото — теж відповідь.
const photoCache = new Map<string, string | null>()

function usePhotos(productIds: readonly string[]): Record<string, string | null> {
  const key = [...new Set(productIds)].sort().join(',')
  const [photos, setPhotos] = useState<Record<string, string | null>>({})
  useEffect(() => {
    const ids = key ? key.split(',') : []
    const known = Object.fromEntries(ids.filter(id => photoCache.has(id)).map(id => [id, photoCache.get(id) ?? null]))
    setPhotos(known)
    const find = desktopBridge()?.catalog?.findById
    const missing = ids.filter(id => !photoCache.has(id))
    if (!find || !missing.length) return
    let cancelled = false
    void Promise.all(missing.map(id => find(id).then(product => [id, product?.photo_url ?? null] as const, () => [id, undefined] as const)))
      .then(found => {
        // Невдале читання не запам'ятовуємо: наступне відкриття спробує ще раз.
        for (const [id, photo] of found) if (photo !== undefined) photoCache.set(id, photo)
        if (!cancelled) setPhotos(Object.fromEntries(ids.filter(id => photoCache.has(id)).map(id => [id, photoCache.get(id) ?? null])))
      })
    return () => { cancelled = true }
  }, [key])
  return photos
}

/** Список позицій із мініатюрами: касир бачить, що саме віддає клієнту. Лише читання. */
export function OrderHandoverItems({ items, limit = 8, orderId }: { items: readonly HandoverItem[]; limit?: number; orderId?: string }) {
  const rows = handoverRows(items)
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? rows : rows.slice(0, limit)
  const photos = usePhotos(shown.flatMap(row => row.productId ? [row.productId] : []))
  // 24.11.2026 (план C2): позиція без картки товару — мініатюра зі скриншота кошика чи з довідника.
  const itemPhotos = useOrderItemPhotos(orderId)
  if (!rows.length) return null
  return (
    <ul className="mb-2 space-y-1">
      {shown.map(row => {
        const photo = (row.productId ? photos[row.productId] : null) ?? itemPhotos[row.id] ?? null
        return (
          <li key={row.id} className="flex items-center gap-2 text-[11px] text-gray-300">
            {photo
              ? <img src={photo} alt="" loading="lazy" draggable={false} className="h-9 w-9 shrink-0 rounded object-cover" />
              : <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-gray-800 text-gray-500">📦</span>}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-white">{row.name}</span>
              <span className="block truncate text-gray-500">{[row.sku, `${row.qty} шт`, formatMoney(row.total)].filter(Boolean).join(' · ')}</span>
            </span>
            <span className={`shrink-0 ${STATE_COLOR[row.state]}`}>{STATE_LABEL[row.state]}</span>
          </li>
        )
      })}
      {rows.length > limit && (
        <li>
          <button type="button" onClick={() => setExpanded(value => !value)} className="text-[11px] text-blue-300 underline">
            {expanded ? 'Згорнути' : `Показати всі позиції (${rows.length})`}
          </button>
        </li>
      )}
    </ul>
  )
}
