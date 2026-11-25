import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/Toast'
import { desktopBridge } from '@/lib/desktopBridge'
import { formatMoney } from '@/lib/utils'
import { posOrderApi } from '@/features/pos/posOrderApi'
import { formatOrderNo } from './orderActions'

type HandOverItem = { id: string; name: string; sku?: string | null; qty: number; sell_price: number; core_deposit_amount?: number | null; item_status?: string | null }
type HandOverOrder = {
  id: string; order_number?: number | null; kp_number?: string | null
  total_amount: number; discount_amount?: number | null; total_paid?: number | null; prepayment?: number | null
  customer_id?: string | null; customer?: { id: string; phone: string; full_name: string | null } | null
  items?: HandOverItem[]
}

/** Неоплачений залишок — та сама арифметика, що в касі: сума − знижка − більше з «оплачено» і «передоплата». */
export function handOverDue(order: HandOverOrder): number {
  const payable = Math.max(0, Number(order.total_amount || 0) - Number(order.discount_amount || 0))
  return Math.max(0, payable - Math.max(Number(order.total_paid || 0), Number(order.prepayment || 0)))
}

const lineTotal = (item: HandOverItem) => Math.round(Number(item.sell_price || 0) * Number(item.qty || 0))
  + Math.round(Number(item.core_deposit_amount || 0) * Number(item.qty || 0))
const isOpen = (item: HandOverItem) => !['canceled', 'handed', 'returned'].includes(String(item.item_status ?? ''))

/**
 * Що станеться з грошима при видачі вибраних позицій — та сама арифметика, що в касі (handOverItems):
 * внесене зараховується у видане; не вистачає — борг клієнта; лишається зайве — на рахунок клієнта.
 * Видаються не всі відкриті позиції — решта переходить у нове замовлення.
 */
export function handOverPlan(order: HandOverOrder, selectedIds: ReadonlySet<string>) {
  const open = (order.items ?? []).filter(isOpen)
  const chosen = open.filter(item => selectedIds.has(item.id))
  const whole = chosen.length === open.length
  const paid = Math.max(Number(order.total_paid || 0), Number(order.prepayment || 0))
  if (whole) {
    const due = handOverDue(order)
    return { whole, handed: Math.max(0, Number(order.total_amount || 0) - Number(order.discount_amount || 0)), paid, debt: due, toAccount: 0, restCount: 0 }
  }
  const handed = chosen.reduce((sum, item) => sum + lineTotal(item), 0)
  return { whole, handed, paid, debt: Math.max(0, handed - paid), toAccount: Math.max(0, paid - handed), restCount: open.length - chosen.length }
}

/**
 * 25.11.2026 (рішення власника): замовлення видає менеджер по замовленнях, а клієнт оплачує на касі.
 * Неоплачене при видачі одразу стає боргом клієнта (закривається на касі: «Розрахунки клієнта» → «Борг»).
 * Видати можуть і менеджер, і касир; кнопка — лише на касі та ПК менеджера (у вебі видачі немає).
 */
export function handOverConfirmText(input: { number: string; customer: string | null; remaining: number }): string {
  return input.remaining > 0
    ? `Видати замовлення ${input.number}${input.customer ? ' клієнту ' + input.customer : ''}?\n\n`
      + `Неоплачені ${formatMoney(input.remaining)} одразу стануть боргом клієнта. `
      + 'Оплату приймає каса: «Розрахунки клієнта» → «Борг».'
    : `Видати замовлення ${input.number}${input.customer ? ' клієнту ' + input.customer : ''}? Замовлення оплачене повністю.`
}

export function canHandOverHere(): boolean {
  return Boolean(desktopBridge()?.orders?.handOver)
}

/** Показувати, коли є хоч одна прибула відкрита позиція. */
export function hasArrivedOpenItems(order: HandOverOrder): boolean {
  return (order.items ?? []).some(item => isOpen(item) && item.item_status === 'arrived')
}

export function HandOverOrderButton({ order, onDone, size }: { order: HandOverOrder; onDone: () => void; size?: 'sm' }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const openItems = useMemo(() => (order.items ?? []).filter(isOpen), [order.items])
  const arrivedIds = useMemo(() => openItems.filter(item => item.item_status === 'arrived').map(item => item.id), [openItems])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  if (!canHandOverHere() || !arrivedIds.length) return null
  const number = formatOrderNo(order)
  const customer = order.customer?.full_name || order.customer?.phone || null
  const hasCustomer = Boolean(order.customer_id || order.customer?.id)
  const plan = handOverPlan(order, selected)
  const blocked = !selected.size
    ? 'Виберіть позиції, які клієнт забирає.'
    : !hasCustomer && (plan.debt > 0 || !plan.whole)
      ? 'Неоплачене або частину замовлення видають лише клієнту — виберіть клієнта в замовленні.'
      : !plan.whole && Number(order.discount_amount || 0) > 0
        ? 'Замовлення має знижку на все замовлення — його видають повністю.'
        : null

  function start() { setSelected(new Set(arrivedIds)); setOpen(true) }
  function toggle(id: string) {
    setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  async function handOver() {
    if (busy || blocked) return
    setBusy(true)
    try {
      const result = await posOrderApi.handOver(order.id, plan.whole ? undefined : [...selected])
      const debt = Number(result?.data?.debt_amount ?? 0)
      const toAccount = Number(result?.data?.moved_to_account ?? 0)
      const rest = result?.data?.rest_order_number
      toast.success(['Видано.', debt > 0 ? `Борг клієнта +${formatMoney(debt)} — оплата на касі.` : '',
        toAccount > 0 ? `На рахунок клієнта ${formatMoney(toAccount)}.` : '', rest ? `Решта — замовлення №${rest}.` : ''].filter(Boolean).join(' '))
      setOpen(false)
      onDone()
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : 'Не вдалося видати замовлення')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button size={size} onClick={start} data-order-hand-over title="Видати товар клієнту; неоплачене стане боргом клієнта"
        className="bg-emerald-600 hover:bg-emerald-700 text-white">
        📦 Видати клієнту
      </Button>
      <Modal open={open} onClose={() => { if (!busy) setOpen(false) }} title={`Видача замовлення ${number}${customer ? ' — ' + customer : ''}`} size="md">
        <div className="space-y-3 text-sm" data-hand-over-dialog>
          <p className="text-gray-600">Позначте, що клієнт забирає зараз. Неприбуле лишається в новому замовленні.</p>
          <div className="divide-y rounded-lg border">
            {openItems.map(item => {
              const arrived = item.item_status === 'arrived'
              return (
                <label key={item.id} className={`flex items-center gap-3 px-3 py-2 ${arrived ? 'cursor-pointer' : 'opacity-60'}`}>
                  <input type="checkbox" disabled={!arrived || busy} checked={selected.has(item.id)} onChange={() => toggle(item.id)} className="h-4 w-4" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-gray-800">{item.name}</span>
                    <span className="text-xs text-gray-500">{item.sku ? item.sku + ' · ' : ''}{item.qty} шт · {formatMoney(lineTotal(item))}</span>
                  </span>
                  <span className={`text-xs ${arrived ? 'text-green-600' : 'text-orange-600'}`}>{arrived ? 'прибуло' : 'ще не прибуло'}</span>
                </label>
              )
            })}
          </div>
          <div className="space-y-1 rounded-lg bg-gray-50 px-3 py-2" data-hand-over-plan>
            <div className="flex justify-between"><span>Видається на суму</span><b>{formatMoney(plan.handed)}</b></div>
            <div className="flex justify-between"><span>Внесено за замовлення</span><span>{formatMoney(plan.paid)}</span></div>
            {plan.debt > 0 && <div className="flex justify-between text-red-700"><span>Стане боргом клієнта</span><b>{formatMoney(plan.debt)}</b></div>}
            {plan.toAccount > 0 && <div className="flex justify-between text-emerald-700"><span>Зайве — на рахунок клієнта</span><b>{formatMoney(plan.toAccount)}</b></div>}
            {plan.restCount > 0 && <div className="text-gray-600">Ще {plan.restCount} поз. переходять у нове замовлення того ж клієнта.</div>}
            {plan.debt > 0 && <div className="text-xs text-gray-500">Оплату приймає каса: «Розрахунки клієнта» → «Борг».</div>}
            {plan.toAccount > 0 && <div className="text-xs text-gray-500">Видати ці гроші готівкою — на касі: «Розрахунки клієнта» → «Зняти з рахунку».</div>}
          </div>
          {blocked && <p role="alert" className="text-sm text-red-700">{blocked}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>Скасувати</Button>
            <Button onClick={handOver} disabled={busy || Boolean(blocked)} data-hand-over-confirm className="bg-emerald-600 hover:bg-emerald-700 text-white">
              {busy ? 'Видача…' : 'Видати'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
