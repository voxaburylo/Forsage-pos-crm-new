import { useEffect, useState } from 'react'
import { Printer, RotateCcw } from 'lucide-react'
import { Badge, Button, Modal } from '@/components/ui'
import { saleApi } from '@/features/pos/saleApi'
import { ReceiptPrint, printReceipt } from '@/features/pos/ReceiptPrint'
import { useLatestRequest } from '@/hooks/useLatestRequest'
import { useAuthStore } from '@/stores/authStore'
import { formatDateTime, formatMoney } from '@/lib/utils'
import type { Sale } from '@/types/sale'
import { salePersonLabel } from './salePeople'
import { saleLineLabel } from './saleLineLabel'

type Detail = Sale & { sync_status?: 'pending' | 'failed' | 'synced' }
const paymentNames: Record<string, string> = { cash: 'Готівка', card: 'Картка', debt: 'Борг', mixed: 'Змішано', transfer: 'Переказ' }

/** Shared existing receipt view: opening is read-only, printing is an explicit action. */
export function SaleDetailModal({ saleId, onClose, onReturn }: {
  saleId: string | null
  onClose: () => void
  onReturn: (sale: Sale) => void
}) {
  const scope = useAuthStore(state => `${state.session?.user?.id ?? ''}:${state.session?.user?.app_metadata?.role ?? ''}`)
  const [loaded, setLoaded] = useState<{ key: string; sale: Detail } | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const key = JSON.stringify([saleId, scope, retry])
  const requests = useLatestRequest(key)
  const detail = loaded?.key === key ? loaded.sale : null
  useEffect(() => {
    setLoaded(null)
    setError('')
    if (!saleId) return
    const isCurrent = requests.begin()
    void saleApi.get(saleId, { silent: true }).then(({ data }) => {
      if (isCurrent()) setLoaded({ key, sale: data })
    }).catch(cause => {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : 'Не вдалося завантажити чек')
    })
    return () => requests.invalidate()
  }, [saleId, key, requests])

  const close = () => { requests.invalidate(); onClose() }
  return <>
    <Modal open={saleId !== null} onClose={close} title={detail ? `Чек #${detail.sale_number}` : 'Перегляд чека'} size="lg">
      {error ? <div role="alert" className="space-y-3 text-sm text-red-700">
        <p>{error}</p><Button variant="secondary" onClick={() => setRetry(value => value + 1)}>Повторити</Button>
      </div> : !detail ? <p role="status" className="py-8 text-center text-sm text-gray-500">Завантаження…</p> : <div className="space-y-4">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt className="text-gray-500">Дата</dt><dd className="text-right">{formatDateTime(detail.completed_at)}</dd>
          <dt className="text-gray-500">Клієнт</dt><dd className="text-right break-words">{detail.customer?.full_name || detail.customer?.phone || 'Анонім'}</dd>
          <dt className="text-gray-500">Касир</dt><dd className="text-right break-words">{salePersonLabel(detail.cashier)}</dd>
          {detail.manager_id && <><dt className="text-gray-500">{detail.is_order_sale ? 'Менеджер замовлення' : 'Виконавець / менеджер'}</dt><dd className="text-right break-words">{salePersonLabel(detail.manager)}</dd></>}
          <dt className="text-gray-500">Оплата</dt><dd className="text-right">{paymentNames[detail.payment_method] ?? detail.payment_method}</dd>
          <dt className="text-gray-500">Статус</dt><dd className="text-right"><Badge color={detail.status === 'returned' ? 'red' : detail.status === 'completed' ? 'green' : 'gray'}>{detail.status === 'returned' ? 'Повернено' : detail.status === 'completed' ? 'Виконано' : detail.status}</Badge></dd>
          {detail.fiscal_number && <><dt className="text-gray-500">Фіскальний чек</dt><dd className="text-right break-all font-mono text-xs">{detail.fiscal_number}</dd></>}
        </dl>
        {!!detail.returns?.length && <section className="space-y-1.5 rounded-xl border border-red-100 bg-red-50/40 p-3">
          <h3 className="text-xs font-semibold uppercase text-red-700">Повернення по чеку</h3>
          {detail.returns.map(item => <div key={item.id} className="flex flex-wrap justify-between gap-2 text-xs">
            <span>{formatDateTime(item.created_at)} — {formatMoney(item.refund_kopecks)}</span>
            <span>{item.fiscal_number ? `ФН ${item.fiscal_number}` : 'без фіск. чека'}</span>
          </div>)}
        </section>}
        <div className="overflow-x-auto rounded-xl border border-gray-100">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500"><tr><th className="p-3 text-left">Товар</th><th className="p-3 text-right">К-сть</th><th className="p-3 text-right">Ціна</th><th className="p-3 text-right">Сума</th></tr></thead>
            <tbody className="divide-y divide-gray-100">{(detail.sale_items ?? []).map(item => <tr key={item.id}>
              <td className="p-3">{saleLineLabel(item)}</td>
              <td className="p-3 text-right">{item.qty}</td><td className="whitespace-nowrap p-3 text-right">{formatMoney(item.unit_price)}</td><td className="whitespace-nowrap p-3 text-right font-medium">{formatMoney(item.total)}</td>
            </tr>)}{!detail.sale_items?.length && <tr><td colSpan={4} className="p-4 text-center text-gray-500">Позиції недоступні</td></tr>}</tbody>
          </table>
        </div>
        <div className="flex flex-wrap justify-between gap-3 text-sm">{detail.discount > 0 && <span>Знижка: {formatMoney(detail.discount)}</span>}<strong className="ml-auto">Разом: {formatMoney(detail.total)}</strong></div>
        <div className="sticky bottom-0 flex flex-wrap gap-2 border-t border-gray-100 bg-white py-3">
          {detail.status === 'completed' && detail.sync_status !== 'pending' && detail.sync_status !== 'failed' && <Button icon={<RotateCcw size={15}/>} onClick={() => onReturn(detail)}>Оформити повернення</Button>}
          <Button variant="secondary" icon={<Printer size={15}/>} onClick={printReceipt}>Друк чека</Button>
          <Button variant="secondary" onClick={close}>Закрити</Button>
        </div>
      </div>}
    </Modal>
    {saleId && detail && <ReceiptPrint sale={detail} sellerName={salePersonLabel(detail.cashier)}/>}
  </>
}
