import { useEffect, useState } from 'react'
import { Button, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { desktopBridge } from '@/lib/desktopBridge'

type Arrival = NonNullable<Awaited<ReturnType<NonNullable<NonNullable<ReturnType<typeof desktopBridge>>['orders']>['arrivalFromInvoice'] & object>>>
const EVENT = 'forsage:order-arrival'

/**
 * 22.11.2026 (етап 10 плану): після проведення накладної каса сама відмічає «прибуло» в замовленнях,
 * які чекали цей товар. Збій тут не має зачіпати саму накладну — вона вже проведена.
 */
export async function announceInvoiceArrival(invoiceId: string | null | undefined): Promise<void> {
  const apply = desktopBridge()?.orders?.arrivalFromInvoice
  if (!apply || !invoiceId) return
  try {
    const result = await apply(invoiceId)
    if (result.already_applied || (!result.orders.length && !result.shortages.length)) return
    window.dispatchEvent(new CustomEvent<Arrival>(EVENT, { detail: result }))
  } catch {
    toast.error('Накладну проведено, але прибуття в замовленнях не відмічено. Відмітьте позиції в «Замовленнях».')
  }
}

const quantity = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '')

/** Вікно «Прибуло для замовлень — кому подзвонити». Живе поруч із маршрутами, тож переживає перехід зі сторінки накладної. */
export function OrderArrivalModal() {
  const [arrival, setArrival] = useState<Arrival | null>(null)
  const [called, setCalled] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState('')

  useEffect(() => {
    const show = (event: Event) => { setArrival((event as CustomEvent<Arrival>).detail); setCalled({}) }
    window.addEventListener(EVENT, show)
    return () => window.removeEventListener(EVENT, show)
  }, [])

  async function markCalled(orderId: string) {
    if (busy) return
    setBusy(orderId)
    try {
      // Модуль замовлень підвантажуємо лише тут: вікно живе поруч із маршрутами і не має гальмувати старт.
      const { orderApi } = await import('./orderApi')
      await orderApi.updateStatus(orderId, 'called')
      setCalled(prev => ({ ...prev, [orderId]: true }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося позначити дзвінок')
    } finally { setBusy('') }
  }

  if (!arrival) return null
  return (
    <Modal open onClose={() => setArrival(null)} title="Прибуло для замовлень">
      <div className="space-y-3 text-sm">
        {arrival.orders.length > 0 && <p className="text-gray-600">Позиції відмічено «прибуло». Подзвоніть клієнтам:</p>}
        <ul className="divide-y divide-gray-100">
          {arrival.orders.map(order => (
            <li key={order.order_id} className="flex flex-wrap items-start gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-gray-900">№ {order.order_number} · {order.customer_name || 'Клієнт без імені'}</div>
                {order.customer_phone
                  ? <a href={`tel:${order.customer_phone}`} className="font-mono text-base font-bold text-blue-700">{order.customer_phone}</a>
                  : <span className="text-gray-400">телефон не вказано</span>}
                <div className="mt-1 text-gray-600">{order.items.map(item => `${item.name} × ${quantity(item.qty)}`).join('; ')}</div>
                <div className={`mt-1 text-xs font-semibold ${order.complete ? 'text-emerald-700' : 'text-amber-700'}`}>
                  {order.complete ? 'Усе замовлення прибуло — можна видавати' : 'Прибула частина замовлення'}
                </div>
              </div>
              {order.complete && (called[order.order_id]
                ? <span className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700">Подзвонили ✓</span>
                : <Button size="sm" variant="secondary" loading={busy === order.order_id} disabled={Boolean(busy)} onClick={() => void markCalled(order.order_id)}>Подзвонили</Button>)}
            </li>
          ))}
        </ul>
        {arrival.shortages.length > 0 && (
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
            <div className="font-semibold">Не вистачило товару — позиції лишились «чекаємо»:</div>
            <ul className="mt-1 list-disc pl-5">
              {arrival.shortages.map((row, index) => (
                <li key={index}>№ {row.order_number}: {row.name} — треба {quantity(row.needed)}, вільно {quantity(row.available)}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex justify-end"><Button onClick={() => setArrival(null)}>Зрозуміло</Button></div>
      </div>
    </Modal>
  )
}
