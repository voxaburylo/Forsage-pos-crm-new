import { api } from '@/lib/api'
import { SITE_CANCEL_REASON } from '@/features/tillCommands/tillSiteCancel'
import { deliverTillAnswer, type TillLinkContext } from './useTillRpc'
import { planTillProductUpdate, type TillProductUpdate } from '@/features/tillCommands/tillCommandModel'
import type { TillOrderCard } from '@/features/tillCommands/tillOrderModel'

interface ClaimedCommand { id: string; operation_id: string; command: string; payload: unknown; requested_by?: string }

/**
 * Каса виконує зміни, поставлені з вебу (рішення власника 17.11.2026).
 * Лише головна каса (не ПК менеджера), лише коли є сервер. Кожна команда забирається з сервера один раз.
 * Коли питати сервер — вирішує useTillLink. Повертає, скільки команд забрано.
 */
export async function claimTillCommands({ bridge, deviceId }: TillLinkContext): Promise<number> {
  if (!bridge?.catalog?.findById) return 0
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
        const cards = new Map<string, TillOrderCard | null>()
        for (const item of order.items) if (item.product_id && !cards.has(item.product_id)) cards.set(item.product_id, await bridge!.catalog.findById!(item.product_id))
        // Спершу всі перевірки каси (картки, ціни) — і лише потім створюємо клієнта: відмова не лишає сліду в базі.
        tillOrderToCreate(order, null, command.operation_id, cards)
        const customerId = order.customer_phone ? (await customerApi.quickCreate(order.customer_phone, order.customer_name ?? '')).data.id : null
        const saved = await orderApi.create(tillOrderToCreate(order, customerId, command.operation_id, cards))
        // 27.11.2026: замовлення, яке на сайті вже скасували, зберігаємо й одразу скасовуємо — грошей у ньому ще немає.
        if (order.canceled) await orderApi.cancel(saved.data.id, false, SITE_CANCEL_REASON)
        return { status: 'done', result: { order_id: saved.data.id, order_number: saved.data.order_number, total_amount: saved.data.total_amount, ...(order.canceled ? { canceled: true } : {}) } }
      }
      // 27.11.2026: покупець скасував замовлення на сайті вже після того, як каса його створила.
      if (command.command === 'order.site_cancel') {
        const { orderApi } = await import('@/features/orders/orderApi')
        const { siteCancelPlan, SITE_CANCEL_REASON: reason } = await import('@/features/tillCommands/tillSiteCancel')
        const orderId = String((command.payload as { order_id?: unknown })?.order_id ?? '')
        const current = await orderApi.get(orderId).then(found => found.data, () => null)
        const plan = siteCancelPlan(current)
        if (plan.action === 'refuse') throw new Error(plan.reason)
        if (plan.action === 'cancel') await orderApi.cancel(orderId, false, reason)
        return { status: 'done', result: { order_id: orderId, canceled: plan.action === 'cancel', note: plan.reason } }
      }
      // 22.11.2026: дозамовлення з вебу — лише нові позиції й примітка до відкритого замовлення; решту каса лишає як є.
      if (command.command === 'order.append') {
        const { checkTillOrderAppend, tillOrderAppendToUpdate } = await import('@/features/tillCommands/tillOrderAppendModel')
        const append = checkTillOrderAppend(command.payload)
        const { orderApi } = await import('@/features/orders/orderApi')
        const cards = new Map<string, TillOrderCard | null>()
        for (const item of append.items) if (item.product_id && !cards.has(item.product_id)) cards.set(item.product_id, await bridge!.catalog.findById!(item.product_id))
        const current = await orderApi.get(append.order_id).then(found => found.data, () => null)
        const saved = await orderApi.update(append.order_id, tillOrderAppendToUpdate(append, current, command.operation_id, cards))
        return { status: 'done', result: { order_id: saved.data.id, order_number: saved.data.order_number, total_amount: saved.data.total_amount, added: append.items.length } }
      }
      // 22.11.2026: накладна з телефона. Каса лише кладе рядки у «вхідні» — нічого не проводить і карток не створює.
      if (command.command === 'invoice.draft') {
        const { PHONE_INVOICE_EVENT, storePhoneInvoice } = await import('@/features/tillCommands/phoneInvoiceModel')
        const stored = storePhoneInvoice(command.operation_id, command.payload)
        window.dispatchEvent(new Event(PHONE_INVOICE_EVENT))
        return { status: 'done', result: { rows: stored.rows } }
      }
      // 22.11.2026: PIN чи пароль працівника, змінений у вебі. У команді лише хеш; право каса перевіряє за автором.
      if (command.command === 'staff.secret') {
        const apply = bridge!.staff?.applyRemoteSecret
        if (!apply) throw new Error('Оновіть програму на касі: вона ще не вміє приймати PIN і пароль із вебу.')
        await apply(String(command.requested_by ?? ''), command.payload)
        return { status: 'done', result: { applied: true } }
      }
      // 27.11.2026: нова категорія під товари постачальників (пропонує помічник сайту, ставить сервер). Дубля каса не створить.
      if (command.command === 'category.create') {
        const [{ tillCategoryToCreate }, { adminApi }] = await Promise.all([import('@/features/tillCommands/tillCategoryModel'), import('@/features/admin/adminApi')])
        const plan = tillCategoryToCreate(command.payload, (await adminApi.listCategories()).data)
        if (plan.existing) return { status: 'done', result: { category_id: plan.existing.id, name: plan.existing.name, created: false } }
        const saved = (await adminApi.createCategory(plan.name) as { data: { id: string; name: string } }).data
        return { status: 'done', result: { category_id: saved.id, name: saved.name, created: true } }
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
  const { data } = await api.post<{ data: ClaimedCommand[] }>('/api/v1/till-commands/claim', { device_id: deviceId, site_orders: true }, undefined, { silent: true, timeoutMs: 10_000 })
  for (const command of data) {
    const outcome = await execute(command)
    // Команду вже виконано в базі каси — відповідь не має загубитися через блимання мережі.
    await deliverTillAnswer(() => api.post(`/api/v1/till-commands/${command.id}/result`, { device_id: deviceId, outcome }, undefined, { silent: true, timeoutMs: 10_000 }))
  }
  return data.length
}
