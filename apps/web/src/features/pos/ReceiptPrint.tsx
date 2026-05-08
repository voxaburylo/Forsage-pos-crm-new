import type { Sale } from '@/types/sale'
import { kopecksToHryvnia } from '@/types/product'
import { formatDateTime } from '@/lib/utils'

interface Props {
  sale: Sale
  shopName?: string
}

const PAY_LABEL: Record<string, string> = {
  cash: 'Готівка', card: 'Картка', debt: 'Борг',
}

export function ReceiptPrint({ sale, shopName = 'Форсаж' }: Props) {
  return (
    <div className="receipt-print hidden print:block font-mono text-xs" style={{ width: 280 }}>
      <style>{`
        @media print {
          body > *:not(.receipt-print) { display: none !important; }
          .receipt-print { display: block !important; }
          @page { margin: 4mm; size: 80mm auto; }
        }
      `}</style>

      {/* Заголовок */}
      <div className="text-center mb-2">
        <p className="text-base font-bold">{shopName}</p>
        <p className="text-xs text-gray-500">Магазин автозапчастин</p>
      </div>

      <div className="border-t border-dashed border-gray-400 my-2" />

      {/* Мета */}
      <p>Чек: #{sale.sale_number}</p>
      <p>Дата: {formatDateTime(sale.completed_at)}</p>
      {sale.customer && (
        <p>Клієнт: {sale.customer.full_name ?? sale.customer.phone}</p>
      )}

      <div className="border-t border-dashed border-gray-400 my-2" />

      {/* Товари */}
      {(sale.sale_items ?? []).map((item, i) => (
        <div key={i} className="mb-1">
          <p className="leading-tight">{item.product?.name ?? item.product_id}</p>
          <div className="flex justify-between">
            <span>{item.qty} {item.product?.unit ?? 'шт'} × {kopecksToHryvnia(item.unit_price)} ₴</span>
            <span>{kopecksToHryvnia(item.total)} ₴</span>
          </div>
          {item.discount > 0 && (
            <p className="text-right text-xs">знижка: -{kopecksToHryvnia(item.discount)} ₴</p>
          )}
        </div>
      ))}

      <div className="border-t border-dashed border-gray-400 my-2" />

      {/* Підсумок */}
      {sale.discount > 0 && (
        <div className="flex justify-between">
          <span>Знижка:</span>
          <span>-{kopecksToHryvnia(sale.discount)} ₴</span>
        </div>
      )}
      <div className="flex justify-between font-bold text-sm">
        <span>РАЗОМ:</span>
        <span>{kopecksToHryvnia(sale.total)} ₴</span>
      </div>
      <p>Оплата: {PAY_LABEL[sale.payment_method] ?? sale.payment_method}</p>

      <div className="border-t border-dashed border-gray-400 my-2" />

      <p className="text-center">Дякуємо за покупку!</p>
    </div>
  )
}

export function printReceipt() {
  window.print()
}
