import type { SupplyInvoice } from '@/types/supplier'
import type { LineItem } from './invoiceFormModel'
import { formatMoney } from '@/lib/utils'

export function InvoiceVersionConflict({ current, items, busy, onReload, onKeep, onOpen }: {
  current: SupplyInvoice; items: LineItem[]; busy: boolean; onReload: () => void; onKeep: () => void; onOpen: () => void
}) {
  return <section role="alert" className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
    <h2 className="font-bold text-amber-950">Звірте версію накладної</h2>
    <p className="mt-1 text-sm text-amber-950">Документ змінився після відкриття або чернетка створена старою версією програми. Ваші правки залишилися у формі. Автоматичного перезапису немає.</p>
    <p className="mt-2 text-sm">У базі: {current.invoice_number || 'без номера'} · {current.supplier?.name || 'постачальника не вказано'} · {formatMoney(current.total)} · оплачено {formatMoney(current.paid_amount ?? 0)}.</p>
    {current.notes && <p className="mt-1 whitespace-pre-wrap break-words text-sm">Примітка у базі: {current.notes}</p>}
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer font-semibold">Порівняти позиції у базі та мої правки</summary>
      <div className="mt-2 grid gap-3 md:grid-cols-2">
        <div><h3 className="font-semibold">Актуальна накладна у базі</h3><ul className="space-y-1">{current.items?.map(item => <li key={item.id} className="break-words">{item.product?.name || item.product_id}: {item.qty} × {formatMoney(item.purchase_price)} = {formatMoney(item.total)}</li>)}</ul></div>
        <div><h3 className="font-semibold">Мої незбережені правки</h3><ul className="space-y-1">{items.map(item => <li key={item.client_key} className="break-words">{item.product_name}: {item.qty} × {formatMoney(item.purchase_price)} = {formatMoney(item.total)}</li>)}</ul></div>
      </div>
    </details>
    <div className="mt-3 flex flex-wrap gap-2">
      {current.status === 'draft' ? <>
        <button type="button" disabled={busy} onClick={onReload} className="rounded-lg border border-amber-400 bg-white px-3 py-2 text-sm">Завантажити актуальну</button>
        <button type="button" disabled={busy} onClick={onKeep} className="rounded-lg bg-amber-300 px-3 py-2 text-sm font-semibold">Я звірив — залишити мої правки</button>
      </> : <button type="button" disabled={busy} onClick={onOpen} className="rounded-lg border border-amber-400 bg-white px-3 py-2 text-sm">Відкрити збережений документ</button>}
    </div>
    <p className="mt-2 text-xs text-amber-900">Після звірки документ не проводиться самостійно. Проведення й оплата залишаються окремою вашою дією.</p>
  </section>
}
