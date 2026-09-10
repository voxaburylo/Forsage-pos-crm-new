import type { SoldItem } from '@/types/report'
import { formatMoney } from '@/lib/utils'

export function SoldItemsMobile({ items }: { items: SoldItem[] }) {
  return <div className="min-w-0 divide-y divide-gray-200 md:hidden" data-testid="sold-items-mobile">
    {items.map(item => <article key={item.product_id} className="min-w-0 p-4 space-y-3">
      <h3 className="text-base font-semibold leading-snug text-gray-900 [overflow-wrap:anywhere]">{item.name}</h3>
      <dl className="space-y-1 text-sm">
        <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2"><dt className="text-gray-500">Артикул</dt><dd className="min-w-0 select-text font-mono [overflow-wrap:anywhere]">{item.sku || '—'}</dd></div>
        {item.barcode && <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2"><dt className="text-gray-500">Штрихкод</dt><dd className="min-w-0 select-text font-mono [overflow-wrap:anywhere]">{item.barcode}</dd></div>}
        {item.storage_bin && <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2"><dt className="text-gray-500">Полиця</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{item.storage_bin}</dd></div>}
      </dl>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg bg-gray-50 p-3 text-sm">
        <div className="min-w-0"><dt className="text-xs text-gray-500">Чисто продано</dt><dd className="font-bold text-base [overflow-wrap:anywhere]">{item.qty_net} {item.unit}</dd></div>
        <div className="min-w-0"><dt className="text-xs text-gray-500">Сума продажів</dt><dd className="font-bold text-base [overflow-wrap:anywhere]">{formatMoney(item.net_revenue)}</dd></div>
        <div className="min-w-0"><dt className="text-xs text-gray-500">Залишок</dt><dd className={`font-medium [overflow-wrap:anywhere] ${item.qty_on_hand <= 0 ? 'text-red-700' : 'text-gray-700'}`}>{item.qty_on_hand} {item.unit}</dd></div>
        <div className="min-w-0"><dt className="text-xs text-gray-500">Середня ціна продажу</dt><dd className="font-medium text-gray-700 [overflow-wrap:anywhere]">{item.qty_sold > 0 ? formatMoney(Math.round(item.revenue / item.qty_sold)) : '—'}</dd></div>
      </dl>
      {item.qty_returned > 0 && <p className="text-xs text-gray-500 [overflow-wrap:anywhere]">Повернуто: {item.qty_returned} {item.unit} · {formatMoney(item.refund_total)}. Повернення враховані в підсумку.</p>}
    </article>)}
  </div>
}
