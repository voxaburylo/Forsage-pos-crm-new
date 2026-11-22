import { useEffect } from 'react'
import { api } from '@/lib/api'
import { desktopBridge, isDesktopRuntime } from '@/lib/desktopBridge'
import { isDesktopAccessLocked } from '@/lib/desktopAccessState'
import { canUseCloudBackground } from '@/lib/lanFirstRun'
import { useAuthStore } from '@/stores/authStore'
import { planTillProductUpdate, type TillProductUpdate } from '@/features/tillCommands/tillCommandModel'

interface ClaimedCommand { id: string; operation_id: string; command: string; payload: unknown; requested_by?: string }
const POLL_MS = 5_000

/**
 * Каса виконує зміни, поставлені з вебу (рішення власника 17.11.2026).
 * Лише головна каса (не ПК менеджера), лише коли є сервер. Кожна команда забирається з сервера один раз.
 */
export function useTillCommands(serverOnline: boolean) {
  const user = useAuthStore(state => state.session?.user)
  const offlineMode = useAuthStore(state => state.offlineMode)
  useEffect(() => {
    const bridge = desktopBridge()
    if (!isDesktopRuntime() || !bridge?.catalog?.findById || !serverOnline || offlineMode || !user) return
    let stopped = false, busy = false, deviceId = ''
    async function execute(command: ClaimedCommand): Promise<{ status: 'done' | 'failed'; result?: Record<string, unknown> | null; error?: string | null }> {
      try {
        // 21.11.2026: зміни каси з вебу. Право дає власник/адмін, який поставив команду (каса перевіряє у своїй базі).
        if (command.command === 'shift.list' || command.command === 'shift.close') {
          const pos = bridge!.pos
          if (!pos?.remoteShifts || !pos.remoteCloseShift) throw new Error('Оновіть програму на касі: вона ще не вміє закривати зміну з вебу.')
          const requestedBy = String(command.requested_by ?? '')
          if (command.command === 'shift.list') return { status: 'done', result: { shifts: await pos.remoteShifts(requestedBy) } }
          const closed = await pos.remoteCloseShift(requestedBy, command.payload as { shift_id: string; cashier_id: string; actual_amount: number; comment: string })
          return { status: 'done', result: { shift_id: closed.id } }
        }
        // 22.11.2026: замовлення з вебу. Каса перевіряє бланк ще раз і створює його під номером операції команди:
        // повтор тієї самої команди повертає те саме замовлення, дубля не буде.
        if (command.command === 'order.save') {
          const { checkTillOrder, tillOrderToCreate } = await import('@/features/tillCommands/tillOrderModel')
          const order = checkTillOrder(command.payload)
          const [{ customerApi }, { orderApi }] = await Promise.all([import('@/features/customers/customerApi'), import('@/features/orders/orderApi')])
          let customerId: string | null = null
          if (order.customer_phone) customerId = (await customerApi.quickCreate(order.customer_phone, order.customer_name ?? '')).data.id
          const saved = await orderApi.create(tillOrderToCreate(order, customerId, command.operation_id))
          return { status: 'done', result: { order_id: saved.data.id, order_number: saved.data.order_number, total_amount: saved.data.total_amount } }
        }
        if (command.command !== 'product.update') throw new Error('Невідома команда. Оновіть програму на касі.')
        const update = command.payload as TillProductUpdate
        const current = await bridge!.catalog.findById!(String(update?.product_id ?? ''))
        const form = planTillProductUpdate(current, update)
        // Модуль товарів підвантажуємо лише коли команда справді прийшла: фоновий агент лишається легким.
        const { productApi } = await import('@/features/products/productApi')
        const saved = await productApi.update(update.product_id, form)
        return { status: 'done', result: { product_id: saved.data.id, name: saved.data.name, sku: saved.data.sku, retail_price: saved.data.retail_price } }
      } catch (error) {
        return { status: 'failed', error: (error instanceof Error ? error.message : 'Каса не змогла виконати зміну').slice(0, 500) }
      }
    }
    async function run() {
      if (stopped || busy || isDesktopAccessLocked()) return
      busy = true
      try {
        if (!await canUseCloudBackground() || stopped) return
        deviceId ||= (await bridge!.getRuntimeInfo()).deviceId
        const { data } = await api.post<{ data: ClaimedCommand[] }>('/api/v1/till-commands/claim', { device_id: deviceId }, undefined, { silent: true, timeoutMs: 10_000 })
        for (const command of data) {
          const outcome = await execute(command)
          await api.post(`/api/v1/till-commands/${command.id}/result`, { device_id: deviceId, outcome }, undefined, { silent: true, timeoutMs: 10_000 }).catch(() => {})
        }
      } catch { /* наступне опитування повторить; веб покаже «каса не в мережі» */ }
      finally { busy = false }
    }
    const timer = window.setInterval(() => { void run() }, POLL_MS)
    void run()
    return () => { stopped = true; window.clearInterval(timer) }
  }, [serverOnline, offlineMode, user?.id])
}
