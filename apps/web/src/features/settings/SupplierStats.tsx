import { leftText, type LoadProgress } from './LoadRing'

/**
 * 26.11.2026, слово власника (скрин «API-ключі»): «налiплено; кружечок біля кожного складу не потрібен — лише фото,
 * товари, кроси, опис: що є і що це дає сайту». Чотири плитки з числом; під числом — дрібно, скільки ще вантажиться.
 */
export interface SupplierStatsSource {
  provider: 'omega' | 'gpl'; offers: number; total_offers: number; linked: number; crosses_done?: number; details_done?: number
  photos_have?: number; descriptions?: number; syncing: boolean; sync_page: number; last_full_sync_at: string | null
  progress?: { price: LoadProgress; crosses?: LoadProgress; details?: LoadProgress; photos?: LoadProgress }
}
export interface StatTile { key: 'goods' | 'photos' | 'crosses' | 'details'; label: string; value: number | null; note: string }

const n = (value: number) => value.toLocaleString('uk-UA')

/** Дрібний рядок під числом: «вантажиться: 3 % · ≈ 26 дн» або пояснення. */
export function loadingNote(progress: LoadProgress | undefined): string {
  if (!progress) return ''
  if (progress.note === 'вимкнено') return 'вимкнено'
  if (!progress.loading) return progress.fraction === 1 ? 'усе завантажено' : progress.note ?? ''
  const left = leftText(progress.eta_ms)
  return ['вантажиться', progress.fraction == null ? '' : `${Math.floor(progress.fraction * 100)} %`, left].filter(Boolean).join(' · ')
}

export function supplierTiles(conn: SupplierStatsSource): StatTile[] {
  const progress = conn.progress
  const goodsNote = conn.syncing ? `вантажиться (сторінка ${conn.sync_page})` : conn.total_offers > conn.offers ? `з ${n(conn.total_offers)} у прайсі` : 'увесь прайс'
  return [
    { key: 'goods', label: 'Товари', value: conn.offers, note: `${goodsNote} · у вас є ${n(conn.linked)}` },
    { key: 'photos', label: 'Фото', value: conn.photos_have ?? 0, note: loadingNote(progress?.photos) || 'на сайті показуються' },
    conn.provider === 'gpl'
      // У API GPL кросів немає: аналоги його товарів беруться з кросів Омеги за артикулом.
      ? { key: 'crosses', label: 'Кроси', value: null, note: 'беруться з Омеги за артикулом' }
      : { key: 'crosses', label: 'Кроси', value: conn.crosses_done ?? 0, note: loadingNote(progress?.crosses) },
    { key: 'details', label: 'Опис', value: conn.provider === 'gpl' ? conn.descriptions ?? 0 : conn.details_done ?? 0, note: loadingNote(progress?.details) },
  ]
}

export function SupplierStats({ conn }: { conn: SupplierStatsSource }) {
  return (
    <div className="mt-3 space-y-1.5" data-supplier-status>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-supplier-tiles>
        {supplierTiles(conn).map(tile => (
          <div key={tile.key} className="min-w-0 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2" data-supplier-tile={tile.key}>
            <p className="text-xs text-gray-500">{tile.label}</p>
            <p className="text-lg font-semibold tabular-nums text-gray-900">{tile.value == null ? '—' : n(tile.value)}</p>
            {tile.note && <p className="line-clamp-2 text-[11px] leading-snug text-gray-500" title={tile.note}>{tile.note}</p>}
          </div>
        ))}
      </div>
      <p className="text-[11px] text-gray-400">
        Усе це бачить сайт і бланк замовлення.{' '}
        {conn.last_full_sync_at ? `Прайс оновлено ${new Date(conn.last_full_sync_at).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}.` : 'Прайс ще не завантажувався.'}
      </p>
    </div>
  )
}
