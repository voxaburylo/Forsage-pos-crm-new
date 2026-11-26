import { useCallback, useEffect, useMemo, useState } from 'react'
import { Barcode, EyeOff, Eye, ExternalLink, ImageOff, Pencil, Percent, Search, Trash2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Button, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import { formatMoney } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import { productApi } from '@/features/products/productApi'
import { BulkEditModal } from '@/features/products/BulkEditModal'
import { canDeleteCatalog } from '@/features/products/catalogDeletePermissions'
import { ProductEditor } from './SiteProductsTab'

/**
 * 26.11.2026, слово власника: «у вкладці “Сайт” — ще всі товари, і наші, і від постачальників, у купі: перегляд,
 * редагування, додавання штрихкоду, масова робота з товарами й цінами; міні-фото; усі основні дані в один рядок,
 * решта — у картці; видаляти теж можна».
 * Наші товари змінюються через головний ПК (як у «Товарах»): ціни, штрихкод, видалення — тим самим шляхом і з тими самими
 * перевірками (ціна не нижча закупки). Товари постачальників — наші поля поверх прайсу в хмарі; «прибрати» — замість
 * видалення, бо наступний прайс повернув би товар.
 */
export interface CatalogRow {
  kind: 'ours' | 'supplier'; id: string; sku: string | null; name: string; brand: string | null; barcode: string | null
  price: number; purchase?: number | null; qty: number; photo: string | null; category: string | null; supplier: string | null
  hidden: boolean; linked: boolean; custom: boolean
}
interface CatalogPage { rows: CatalogRow[]; total: number; ours_total: number; page: number; pages: number }
interface OfferCard {
  key: string; supplier: string; number: string; brand: string | null; name: string; custom_name: string | null; barcode: string | null; custom_barcode: string | null
  retail_price: number; custom_price: number | null; purchase_price?: number; hidden: boolean; image_url: string | null; description: string | null; category_name: string | null
  total_qty: number; stock: Array<{ warehouse: string; qty: number; days_to_ship: number | null; active: boolean }>; product_id: string | null
}

const BASE = '/api/v1/site-admin/catalog'
const quiet = { silent: true, timeoutMs: 30_000 }
const message = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback
const qtyText = (qty: number) => Number.isInteger(qty) ? String(qty) : qty.toFixed(2)

export const catalogApi = {
  list: (params: { q: string; source: string; flag: string; page: number }) =>
    api.get<{ data: CatalogPage }>(`${BASE}?${new URLSearchParams({ q: params.q, source: params.source, flag: params.flag, page: String(params.page), per_page: '50' })}`, quiet),
  offer: (key: string) => api.get<{ data: OfferCard }>(`${BASE}/offers/${encodeURIComponent(key)}`, quiet),
  patchOffer: (key: string, body: Record<string, unknown>) => api.patch<{ data: OfferCard }>(`${BASE}/offers/${encodeURIComponent(key)}`, body, quiet),
  bulkOffers: (body: { keys: string[]; hidden?: boolean; price_pct?: number; reset_price?: boolean }) =>
    api.post<{ data: { changed: number; below_purchase: number } }>(`${BASE}/offers/bulk`, body, undefined, quiet),
}

export function SiteAllProductsTab() {
  const navigate = useNavigate()
  const role = useAuthStore(state => state.session?.user.app_metadata?.role as string | undefined)
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('all')
  const [flag, setFlag] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<CatalogPage | null>(null)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState<Map<string, CatalogRow>>(new Map())
  const [busy, setBusy] = useState('')
  const [offer, setOffer] = useState<string | null>(null)
  // 26.11.2026: наш товар відкривається тут же — фото, опис і «сховати» для сайту; повна картка програми — кнопкою.
  const [own, setOwn] = useState<CatalogRow | null>(null)
  const [bulkPrices, setBulkPrices] = useState(false)

  // Пошук — через пів секунди після останньої літери, щоб не смикати сервер на кожну.
  useEffect(() => { const timer = window.setTimeout(() => { setQuery(q.trim()); setPage(1) }, 450); return () => window.clearTimeout(timer) }, [q])
  const load = useCallback(async () => {
    try { setData((await catalogApi.list({ q: query, source, flag, page })).data); setError('') }
    catch (reason) { setError(message(reason, 'Не вдалося отримати товари. Потрібен інтернет.')) }
  }, [query, source, flag, page])
  useEffect(() => { void load() }, [load])

  const ours = useMemo(() => [...picked.values()].filter(row => row.kind === 'ours'), [picked])
  const offers = useMemo(() => [...picked.values()].filter(row => row.kind === 'supplier'), [picked])
  const toggle = (row: CatalogRow, on: boolean) => setPicked(current => { const next = new Map(current); if (on) next.set(row.id, row); else next.delete(row.id); return next })
  const pageRows = data?.rows ?? []
  const allPicked = pageRows.length > 0 && pageRows.every(row => picked.has(row.id))

  async function run(label: string, action: () => Promise<string | void>) {
    setBusy(label)
    try { const done = await action(); if (done) toast.success(done); await load() } catch (reason) { toast.error(message(reason, 'Не вдалося')) } finally { setBusy('') }
  }

  const barcodeForOurs = () => run('barcode', async () => {
    let made = 0
    for (const row of ours.filter(item => !item.barcode)) { await productApi.generateBarcode(row.id); made += 1 }
    setPicked(new Map())
    return made ? `Згенеровано штрихкодів: ${made}. Перевірка на дублі — програмою каси.` : 'У вибраних товарів штрихкод уже є'
  })
  const deleteOurs = () => {
    if (!window.confirm(`Видалити ${ours.length} наших товарів? Картки підуть в архів каси (як у «Товарах»).`)) return
    void run('delete', async () => {
      let removed = 0
      for (const row of ours) { await productApi.delete(row.id); removed += 1 }
      setPicked(new Map())
      return `Видалено: ${removed}`
    })
  }
  const offersBulk = (body: { hidden?: boolean; price_pct?: number; reset_price?: boolean }, done: (result: { changed: number; below_purchase: number }) => string) => run('offers', async () => {
    const result = (await catalogApi.bulkOffers({ keys: offers.map(row => row.id), ...body })).data
    setPicked(new Map())
    return done(result)
  })
  const offersPrice = () => {
    const text = window.prompt('На скільки відсотків змінити ціну на сайті? Напр. 10 або -5. Нижче закупки програма не опустить.', '5')
    if (text === null) return
    const pct = Number(text.replace(',', '.'))
    if (!Number.isFinite(pct) || pct === 0 || pct < -90 || pct > 500) { toast.error('Вкажіть відсоток від -90 до 500'); return }
    offersBulk({ price_pct: pct }, result => `Ціну змінено: ${result.changed}` + (result.below_purchase ? `; ${result.below_purchase} не змінено — було б нижче закупки` : ''))
  }

  return (
    <div className="space-y-3" data-site-all-products>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-[14rem] flex-1 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2">
          <Search size={15} className="text-gray-400" aria-hidden="true" />
          <input value={q} onChange={event => setQ(event.target.value)} placeholder="Назва, артикул чи штрихкод" aria-label="Пошук товару" className="w-full bg-transparent text-sm outline-none" />
        </label>
        <select aria-label="Чиї товари" value={source} onChange={event => { setSource(event.target.value); setPage(1) }} className="rounded-lg border border-gray-200 bg-white px-2 py-2 text-sm">
          <option value="all">Усі</option><option value="ours">Наші</option><option value="supplier">Від постачальників</option>
        </select>
        <select aria-label="Відбір" value={flag} onChange={event => { setFlag(event.target.value); setPage(1) }} className="rounded-lg border border-gray-200 bg-white px-2 py-2 text-sm">
          <option value="">Без відбору</option><option value="no_barcode">Без штрихкоду</option><option value="no_photo">Без фото</option>
          <option value="no_stock">Немає в наявності</option><option value="hidden">Прибрані з сайту</option>
        </select>
      </div>

      {picked.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm" data-site-bulk>
          <span className="font-medium">Вибрано: {picked.size}</span>
          {ours.length > 0 && <>
            <span className="text-gray-500">наші {ours.length}:</span>
            <Button size="sm" variant="secondary" icon={<Percent size={14} />} onClick={() => setBulkPrices(true)}>Ціни, категорія…</Button>
            <Button size="sm" variant="secondary" icon={<Barcode size={14} />} loading={busy === 'barcode'} onClick={() => void barcodeForOurs()}>Штрихкоди, де немає</Button>
            {canDeleteCatalog(role) && <Button size="sm" variant="danger-outline" icon={<Trash2 size={14} />} loading={busy === 'delete'} onClick={deleteOurs}>Видалити</Button>}
          </>}
          {offers.length > 0 && <>
            <span className="text-gray-500">постачальників {offers.length}:</span>
            <Button size="sm" variant="secondary" icon={<Percent size={14} />} loading={busy === 'offers'} onClick={offersPrice}>Ціна ±%</Button>
            <Button size="sm" variant="secondary" loading={busy === 'offers'} onClick={() => offersBulk({ reset_price: true }, result => `Ціна за сіткою націнок повернута: ${result.changed}`)}>Ціна за сіткою</Button>
            <Button size="sm" variant="secondary" icon={<EyeOff size={14} />} loading={busy === 'offers'} onClick={() => offersBulk({ hidden: true }, result => `Прибрано з сайту й підказок: ${result.changed}`)}>Прибрати</Button>
            <Button size="sm" variant="ghost" icon={<Eye size={14} />} loading={busy === 'offers'} onClick={() => offersBulk({ hidden: false }, result => `Повернуто: ${result.changed}`)}>Повернути</Button>
          </>}
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Map())}>Зняти вибір</Button>
        </div>
      )}

      {error && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{error}</p>}
      {!data && !error && <p role="status" className="py-4 text-sm text-gray-500">Завантажуємо…</p>}
      {data && (
        <>
          <p className="text-xs text-gray-500">Знайдено {data.total.toLocaleString('uk-UA')}: наших {data.ours_total.toLocaleString('uk-UA')}, постачальників {(data.total - data.ours_total).toLocaleString('uk-UA')}. Натисніть рядок — відкриється картка.</p>
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="flex items-center gap-2 border-b border-gray-100 bg-gray-50 px-2 py-1.5 text-xs text-gray-500">
              <input type="checkbox" aria-label="Вибрати всі на сторінці" checked={allPicked} onChange={event => { for (const row of pageRows) toggle(row, event.target.checked) }} />
              <span className="flex-1">Товар</span><span className="hidden w-28 sm:block">Штрихкод</span><span className="w-[4.6rem] text-right sm:w-24">Ціна</span><span className="w-8 text-right sm:w-12">К-сть</span><span className="hidden w-6 sm:block" />
            </div>
            <ul className="divide-y divide-gray-100">
              {pageRows.map(row => (
                <li key={row.kind + row.id} className={`flex items-center gap-2 px-2 py-1.5 text-sm ${row.hidden ? 'opacity-50' : ''}`} data-catalog-row={row.kind}>
                  <input type="checkbox" aria-label={'Вибрати ' + row.name} checked={picked.has(row.id)} onChange={event => toggle(row, event.target.checked)} />
                  {row.photo ? <img src={row.photo} alt="" loading="lazy" className="h-9 w-9 shrink-0 rounded object-cover" />
                    : <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-gray-100 text-gray-300"><ImageOff size={14} aria-hidden="true" /></span>}
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => row.kind === 'ours' ? setOwn(row) : setOffer(row.id)}>
                    <span className="line-clamp-2 font-medium leading-snug text-gray-900 sm:line-clamp-1">{row.name}</span>
                    <span className="block truncate text-xs text-gray-500">
                      <span className={`mr-1 rounded px-1 ${row.kind === 'ours' ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'}`}>{row.kind === 'ours' ? 'наш' : row.supplier}</span>
                      {[row.sku, row.brand, row.category].filter(Boolean).join(' · ')}
                      {row.kind === 'supplier' && row.linked ? ' · є в нас' : ''}{row.hidden ? ' · прибрано' : ''}{row.custom ? ' · змінено' : ''}
                    </span>
                  </button>
                  <span className="hidden w-28 truncate font-mono text-xs text-gray-600 sm:block">{row.barcode || <span className="text-gray-300">—</span>}</span>
                  <span className="w-[4.6rem] shrink-0 text-right text-[13px] tabular-nums sm:w-24 sm:text-sm">{formatMoney(row.price)}</span>
                  <span className={`w-8 shrink-0 text-right tabular-nums sm:w-12 ${row.qty > 0 ? "text-gray-700" : "text-gray-300"}`}>{qtyText(row.qty)}</span>
                  <button type="button" aria-label={"Відкрити " + row.name} className="hidden rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 sm:block"
                    onClick={() => row.kind === 'ours' ? setOwn(row) : setOffer(row.id)}><Pencil size={14} /></button>
                </li>
              ))}
              {!pageRows.length && <li className="px-3 py-8 text-center text-sm text-gray-400">Нічого не знайдено</li>}
            </ul>
          </div>
          {data.pages > 1 && (
            <div className="flex items-center justify-end gap-2 text-sm">
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Назад</Button>
              <span>{page} з {data.pages.toLocaleString('uk-UA')}</span>
              <Button size="sm" variant="secondary" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>Далі</Button>
            </div>
          )}
        </>
      )}
      {bulkPrices && <BulkEditModal open productIds={ours.map(row => row.id)} onClose={() => setBulkPrices(false)} onUpdated={() => { setBulkPrices(false); setPicked(new Map()); void load() }} />}
      {own && <OwnProductModal row={own} onClose={() => setOwn(null)} onOpenCard={() => navigate('/products/' + own.id)} />}
      {offer && <OfferCardModal offerKey={offer} onClose={() => setOffer(null)} onSaved={() => void load()} />}
    </div>
  )
}

/** Наш товар у розділі «Сайт»: те, що бачить лише сайт (фото, опис, характеристики, «сховати»). Назва, ціна, залишок, штрихкод — у картці програми. */
function OwnProductModal({ row, onClose, onOpenCard }: { row: CatalogRow; onClose: () => void; onOpenCard: () => void }) {
  return (
    <Modal open onClose={onClose} title={row.name} size="lg">
      <div className="space-y-4" data-site-own-card={row.id}>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
          <span>{[row.sku ? 'Артикул ' + row.sku : '', row.barcode ? 'Штрихкод ' + row.barcode : '', formatMoney(row.price), 'залишок ' + qtyText(row.qty)].filter(Boolean).join(' · ')}</span>
          <Button size="sm" variant="secondary" icon={<ExternalLink size={14} />} onClick={onOpenCard} data-site-open-card>Назва, ціна, штрихкод — у картці програми</Button>
        </div>
        <ProductEditor product={{ id: row.id, name: row.name, sku: row.sku, barcode: row.barcode }} />
      </div>
    </Modal>
  )
}

/** Картка товару постачальника: усі дані, склади, наша назва, штрихкод, ціна для сайту, «прибрати». */
function OfferCardModal({ offerKey, onClose, onSaved }: { offerKey: string; onClose: () => void; onSaved: () => void }) {
  const [card, setCard] = useState<OfferCard | null>(null)
  const [name, setName] = useState('')
  const [barcode, setBarcode] = useState('')
  const [price, setPrice] = useState('')
  const [busy, setBusy] = useState(false)
  const fill = (data: OfferCard) => {
    setCard(data); setName(data.custom_name ?? ''); setBarcode(data.custom_barcode ?? '')
    setPrice(data.custom_price == null ? '' : String(data.custom_price / 100))
  }
  useEffect(() => { catalogApi.offer(offerKey).then(result => fill(result.data), reason => toast.error(message(reason, 'Не вдалося відкрити товар'))) }, [offerKey])

  async function save(patch: Record<string, unknown>) {
    setBusy(true)
    try { fill((await catalogApi.patchOffer(offerKey, patch)).data); onSaved(); toast.success('Збережено') }
    catch (reason) { toast.error(message(reason, 'Не вдалося зберегти')) } finally { setBusy(false) }
  }
  function saveAll() {
    const priceText = price.trim().replace(',', '.')
    const kopecks = priceText === '' ? null : Math.round(Number(priceText) * 100)
    if (kopecks !== null && (!Number.isFinite(kopecks) || kopecks < 0)) { toast.error('Ціна — число в гривнях'); return }
    if (kopecks !== null && card?.purchase_price != null && kopecks < card.purchase_price) { toast.error('Ціна нижча за закупівельну — так продавати не можна'); return }
    void save({ custom_name: name.trim() || null, custom_barcode: barcode.trim() || null, custom_price: kopecks })
  }

  return (
    <Modal open onClose={onClose} title={card ? card.name : 'Товар постачальника'} size="lg">
      {!card ? <p role="status" className="text-sm text-gray-500">Завантажуємо…</p> : (
        <div className="space-y-3 text-sm" data-offer-card>
          <div className="flex gap-3">
            {card.image_url ? <img src={card.image_url} alt="" className="h-24 w-24 shrink-0 rounded-lg object-cover" /> : null}
            <div className="min-w-0 space-y-0.5">
              <p className="text-gray-500">{card.supplier} · арт. {card.number}{card.brand ? ' · ' + card.brand : ''}{card.category_name ? ' · ' + card.category_name : ''}</p>
              <p>Ціна для сайту: <b>{formatMoney(card.custom_price ?? card.retail_price)}</b>{card.custom_price != null && <span className="text-gray-500"> (за сіткою {formatMoney(card.retail_price)})</span>}
                {card.purchase_price != null && <span className="text-gray-500"> · закупка {formatMoney(card.purchase_price)}</span>}</p>
              <p>У постачальника: <b>{qtyText(card.total_qty)}</b>{card.product_id && <span className="text-gray-500"> · є така картка в нас</span>}</p>
            </div>
          </div>
          {card.stock.length > 0 && (
            <ul className="rounded-lg border border-gray-100 text-xs">
              {card.stock.map(row => (
                <li key={row.warehouse} className={`flex justify-between border-b border-gray-100 px-2 py-1 last:border-0 ${row.active ? '' : 'text-gray-400'}`}>
                  <span>{row.warehouse}{row.active ? '' : ' (вимкнено)'}</span><span>{qtyText(row.qty)} шт{row.days_to_ship != null ? ` · ${row.days_to_ship} дн.` : ''}</span>
                </li>
              ))}
            </ul>
          )}
          {card.description && <p className="whitespace-pre-line text-xs text-gray-600">{card.description}</p>}
          <label className="block"><span className="text-xs text-gray-500">Наша назва (прайс її не перезапише). Порожньо — назва постачальника: {card.name}</span>
            <input value={name} onChange={event => setName(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2" /></label>
          <div className="flex flex-wrap gap-2">
            <label className="min-w-[10rem] flex-1"><span className="text-xs text-gray-500">Штрихкод{card.barcode ? ` (у постачальника ${card.barcode})` : ''}</span>
              <input value={barcode} onChange={event => setBarcode(event.target.value)} inputMode="numeric" className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 font-mono" /></label>
            <label className="w-40"><span className="text-xs text-gray-500">Ціна для сайту, грн</span>
              <input value={price} onChange={event => setPrice(event.target.value)} inputMode="decimal" placeholder={String(card.retail_price / 100)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2" /></label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button loading={busy} onClick={saveAll}>Зберегти</Button>
            <Button variant="secondary" icon={card.hidden ? <Eye size={14} /> : <EyeOff size={14} />} loading={busy} onClick={() => void save({ hidden: !card.hidden })}>
              {card.hidden ? 'Повернути на сайт' : 'Прибрати з сайту й підказок'}</Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
