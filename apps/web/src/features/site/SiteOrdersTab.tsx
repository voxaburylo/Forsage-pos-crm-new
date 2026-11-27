import { useEffect, useState } from 'react'
import { PackagePlus, RefreshCw, Save } from 'lucide-react'
import { Button, Card, Input, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import { desktopBridge, isDesktopRuntime } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'
import {
  ORDER_STATUSES, ORDER_STATUS_TEXT, errorText, isUuid, siteCall, siteOrderToProgramOrder, uah, useSiteData,
  type SiteOrder, type SiteOrderStatus,
} from './siteGateway'

export interface SiteOrderLink { id: string; external_id: string; canceled: boolean; site_status: string | null; program_order_number: string | null; waiting_till: boolean }
/** Чому замовлення програми створювати не треба; порожньо — можна. */
export function siteOrderLinkProblem(link: SiteOrderLink): string {
  if (link.program_order_number) return 'За цим замовленням сайту вже є замовлення програми № ' + link.program_order_number + '.'
  if (link.waiting_till) return 'Це замовлення вже передано на касу — воно зʼявиться в «Замовленнях», коли каса на звʼязку.'
  if (link.canceled) return 'Покупець скасував це замовлення на сайті — у програмі його не створюємо.'
  return ''
}

const TONE: Record<SiteOrderStatus, string> = {
  new: 'bg-red-100 text-red-800', confirmed: 'bg-amber-100 text-amber-900', shipped: 'bg-blue-100 text-blue-800',
  completed: 'bg-emerald-100 text-emerald-800', canceled: 'bg-gray-100 text-gray-600',
}

/**
 * Створює замовлення в програмі тим самим шляхом, що бланк із телефона: на касі — одразу у своїй базі,
 * у вебі — командою на касу. Гроші тут не рухаються. Повертає текст для коментаря менеджера на сайті.
 */
async function createInProgram(order: SiteOrder, confirmedBy: string): Promise<string> {
  // 27.11.2026, правило власника: без оплати товар не бронюється. Менеджер натискає «Оплачено» — лише тоді замовлення
  // зʼявляється в програмі й бронює товар (з позначкою «ОПЛАЧЕНО НА САЙТІ (підтвердив менеджер)»).
  const base = siteOrderToProgramOrder(order).payload
  const payload = { ...base, paid: { amount: Math.round((Number(order.total) || 0) * 100), paid_at: new Date().toISOString(), method: 'manual' as const, confirmed_by: confirmedBy || null } }
  if (!payload.items.length) throw new Error('У цьому замовленні немає товарів із каталогу програми (лише шини сайту) — у програмі створювати нічого.')
  // 27.11.2026: сервер уже зберіг це замовлення сайту у себе; номер його рядка — номер операції на касі, тож двічі не створиться.
  const link = (await api.get<{ data: SiteOrderLink }>(`/api/v1/site-admin/orders/${encodeURIComponent(String(order.id))}/link`)).data
  const refusal = siteOrderLinkProblem(link)
  if (refusal) throw new Error(refusal)
  const operationId = link.id
  const bridge = desktopBridge()
  if (isDesktopRuntime() && bridge?.catalog?.findById) {
    const [{ checkTillOrder, tillOrderToCreate }, { customerApi }, { orderApi }] = await Promise.all([
      import('@/features/tillCommands/tillOrderModel'), import('@/features/customers/customerApi'), import('@/features/orders/orderApi')])
    const checked = checkTillOrder(payload)
    const cards = new Map<string, Awaited<ReturnType<NonNullable<typeof bridge.catalog.findById>>>>()
    for (const item of checked.items) if (item.product_id && !cards.has(item.product_id)) cards.set(item.product_id, await bridge.catalog.findById(item.product_id))
    // Спершу всі перевірки (картки, ціна не нижче закупки) — і лише потім клієнт і замовлення.
    tillOrderToCreate(checked, null, operationId, cards as never)
    const customerId = checked.customer_phone ? (await customerApi.quickCreate(checked.customer_phone, checked.customer_name ?? '')).data.id : null
    const saved = await orderApi.create(tillOrderToCreate(checked, customerId, operationId, cards as never))
    await api.post(`/api/v1/site-admin/orders/${encodeURIComponent(String(order.id))}/program-order`, { order_id: saved.data.id, order_number: String(saved.data.order_number ?? '') }, undefined, { silent: true }).catch(() => undefined)
    return 'Замовлення програми № ' + saved.data.order_number
  }
  await api.post('/api/v1/till-commands', { operation_id: operationId, command: 'order.save', payload }, undefined, { silent: true, timeoutMs: 15_000 })
  return 'Передано на касу (зʼявиться в «Замовленнях», коли каса на звʼязку)'
}

function OrderCard({ order, onClose, onChanged }: { order: SiteOrder; onClose: () => void; onChanged: () => void }) {
  const [status, setStatus] = useState<SiteOrderStatus>(order.status)
  const [tracking, setTracking] = useState(order.tracking_number ?? '')
  const [note, setNote] = useState(order.manager_comment ?? '')
  const [busy, setBusy] = useState(false)
  const { textOnly, payload } = siteOrderToProgramOrder(order)
  const confirmedBy = useAuthStore(store => String(store.session?.user?.user_metadata?.full_name ?? '').trim())
  const paidOnline = order.paid === true

  async function save() {
    setBusy(true)
    try {
      await siteCall('orders.update', { id: order.id, status, tracking_number: tracking.trim(), manager_comment: note.trim() })
      toast.success('Збережено — покупець побачить статус у кабінеті'); onChanged(); onClose()
    } catch (reason) { toast.error(errorText(reason)) } finally { setBusy(false) }
  }

  async function toProgram() {
    if (!window.confirm(`Гроші за замовлення № ${order.id} (${uah(order.total)}) отримано?\nПісля цього замовлення зʼявиться в програмі, а товар заброниться.`)) return
    if (/замовлення програми|передано на касу/i.test(note) && !window.confirm('Схоже, це замовлення вже передавали в програму. Передати ще раз?')) return
    setBusy(true)
    try {
      const result = await createInProgram(order, confirmedBy)
      const next = [note.trim(), result].filter(Boolean).join('. ')
      setNote(next)
      await siteCall('orders.update', { id: order.id, manager_comment: next })
      toast.success(result); onChanged()
    } catch (reason) { toast.error(errorText(reason, 'Не вдалося створити замовлення в програмі')) } finally { setBusy(false) }
  }

  return (
    <Modal open onClose={onClose} title={'Замовлення сайту № ' + order.id} size="lg">
      <div className="space-y-3 text-sm" data-site-order-card>
        <div className="grid gap-1 sm:grid-cols-2">
          <p><span className="text-gray-500">Клієнт:</span> {order.customer_name || '—'}</p>
          <p><span className="text-gray-500">Телефон:</span> {order.customer_phone || '—'}</p>
          <p><span className="text-gray-500">Пошта:</span> {order.customer_email || '—'}</p>
          <p><span className="text-gray-500">Створено:</span> {new Date(order.created_at).toLocaleString('uk-UA')}</p>
          <p className="sm:col-span-2"><span className="text-gray-500">Доставка:</span> {[order.delivery_method, order.city, order.warehouse].filter(Boolean).join(', ') || '—'}</p>
          {order.comment && <p className="sm:col-span-2"><span className="text-gray-500">Коментар клієнта:</span> {order.comment}</p>}
        </div>
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-100">
          {(order.items ?? []).map((item, index) => (
            <li key={index} className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-2">
              <span className="min-w-0 break-words">{item.title}{!isUuid(item.program_product_id) && <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">не з програми</span>}</span>
              <span className="shrink-0 text-gray-700">{item.qty} × {uah(item.price)}</span>
            </li>
          ))}
          <li className="flex justify-between px-3 py-2 font-semibold"><span>Разом</span><span>{uah(order.total)}</span></li>
        </ul>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-gray-700">Статус</span>
            <select value={status} onChange={event => setStatus(event.target.value as SiteOrderStatus)} data-site-order-status
              className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent">
              {ORDER_STATUSES.map(value => <option key={value} value={value}>{ORDER_STATUS_TEXT[value]}</option>)}
            </select>
          </label>
          <Input label="ТТН (номер накладної)" value={tracking} maxLength={60} onChange={event => setTracking(event.target.value)} />
        </div>
        <Input label="Коментар менеджера" value={note} maxLength={500} onChange={event => setNote(event.target.value)} />
        {paidOnline ? (
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900">💳 Оплачено онлайн — замовлення в програмі створиться само (за хвилину), товар заброниться.</p>
        ) : (
          <p className="text-xs text-gray-500">
            Без оплати товар не бронюється. Коли гроші отримано — «Оплачено»: замовлення зʼявиться в «Замовленнях» програми з позначкою «оплачено», товари з каталогу ({payload.items.length}) заброняться
            {textOnly.length ? `, решта (${textOnly.length}) — текстом у примітці` : ''}.
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {!paidOnline && <Button variant="secondary" icon={<PackagePlus size={14} />} loading={busy} onClick={() => void toProgram()} data-site-order-to-program>Оплачено — створити й забронювати</Button>}
          <Button icon={<Save size={14} />} loading={busy} onClick={() => void save()}>Зберегти</Button>
        </div>
      </div>
    </Modal>
  )
}

export function SiteOrdersTab() {
  const [status, setStatus] = useState<SiteOrderStatus | ''>('')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<SiteOrder | null>(null)
  useEffect(() => { const timer = window.setTimeout(() => setQuery(search.trim()), 400); return () => window.clearTimeout(timer) }, [search])
  const { data, error, loading, reload } = useSiteData<SiteOrder[]>('orders.list', { ...(status ? { status } : {}), ...(query ? { search: query } : {}), limit: 50, offset: 0 })
  const orders = Array.isArray(data) ? data : []

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="min-w-[12rem] flex-1"><Input label="Пошук" placeholder="Імʼя, телефон або номер" value={search} onChange={event => setSearch(event.target.value)} /></div>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-gray-700">Статус</span>
          <select value={status} onChange={event => setStatus(event.target.value as SiteOrderStatus | '')} className="rounded-lg border border-gray-200 px-3 py-2.5 text-sm">
            <option value="">Усі</option>
            {ORDER_STATUSES.map(value => <option key={value} value={value}>{ORDER_STATUS_TEXT[value]}</option>)}
          </select>
        </label>
        <Button variant="secondary" icon={<RefreshCw size={14} />} loading={loading} onClick={() => void reload()}>Оновити</Button>
      </div>
      {error && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{error}</p>}
      {!error && !loading && orders.length === 0 && <p data-site-empty className="mx-auto max-w-xl py-8 text-center text-sm text-gray-500">Замовлень із сайту за цим відбором немає. Нове замовлення зʼявиться тут само, а на «Сайт» у меню загориться червоний значок.</p>}
      <ul className="divide-y divide-gray-100" data-site-orders>
        {orders.map(order => (
          <li key={order.id}>
            <button type="button" onClick={() => setOpen(order)} className="flex w-full flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-1 py-3 text-left text-sm hover:bg-gray-50">
              <span className="min-w-0">
                <span className={`mr-2 rounded px-1.5 py-0.5 text-xs font-medium ${TONE[order.status] ?? TONE.canceled}`}>{ORDER_STATUS_TEXT[order.status] ?? order.status}</span>
                <span className="font-medium text-gray-900">{order.customer_name || 'Без імені'}</span>
                <span className="text-gray-500"> · {order.customer_phone || '—'} · {new Date(order.created_at).toLocaleString('uk-UA')}</span>
                {order.tracking_number && <span className="text-gray-500"> · ТТН {order.tracking_number}</span>}
              </span>
              <span className="shrink-0 font-medium text-gray-800">{uah(order.total)}</span>
            </button>
          </li>
        ))}
      </ul>
      {open && <OrderCard key={open.id} order={open} onClose={() => setOpen(null)} onChanged={() => void reload()} />}
    </Card>
  )
}
