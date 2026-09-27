import { useEffect, useState } from 'react'
import { desktopBridge } from '@/lib/desktopBridge'
import type { CustomerOrder } from './orderApi'

export function OrderLanBadge({ order }: { order: { lan_sync?: CustomerOrder['lan_sync'] } }) {
  if (!order.lan_sync) return null
  const text = order.lan_sync.state === 'blocked' ? 'Потрібна перевірка' : order.lan_sync.state === 'cached' ? 'Збережена копія' : 'Очікує передавання'
  return <span title={order.lan_sync.message} className={`inline-block rounded px-2 py-1 text-xs font-semibold ${order.lan_sync.state === 'blocked' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'}`}>{text}</span>
}

export function OrderLanNotice() {
  const [status, setStatus] = useState<{ client: boolean; connected: boolean; pending: number; blocked: number } | null>(null)
  useEffect(() => {
    const read = desktopBridge()?.orders?.offlineStatus
    if (!read) return
    let active = true, timer: ReturnType<typeof setTimeout> | undefined, previous = -1, wasConnected: boolean | undefined
    const poll = async () => {
      try {
        const next = await read()
        if (!active) return
        setStatus(next)
        if ((previous >= 0 && next.pending < previous) || (wasConnected === false && next.connected)) window.dispatchEvent(new Event('forsage:lan-orders-changed'))
        previous = next.pending
        wasConnected = next.connected
        if (!next.client) return
      } catch { if (!active) return }
      timer = setTimeout(() => { void poll() }, 15_000)
    }
    void poll()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [])
  if (!status?.client || (status.connected && !status.pending)) return null
  return <div role="status" className="mx-3 my-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
    <p className="font-semibold">{status.connected ? 'Передавання замовлень на головний ПК' : 'Немає зв’язку з головним ПК — замовлення можна зберігати тут'}</p>
    <p>Оплата, видача, прихід, списання та ревізія — лише за наявності зв’язку. Офлайн-замовлення не змінюють залишки й резерви.</p>
    {status.pending > 0 && <p>Очікують підтвердження: {status.pending}.{status.blocked > 0 ? ` Потребують перевірки: ${status.blocked}. Відкрийте позначені замовлення.` : ' Передавання повториться автоматично.'}</p>}
    {!status.connected && <p className="mt-1 text-xs">Нові дані клієнта можна записати у примітці замовлення. Створення картки клієнта потребує зв’язку.</p>}
  </div>
}
