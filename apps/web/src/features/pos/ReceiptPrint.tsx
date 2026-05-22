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
    <div className="receipt-print">
      <style>{`
        /* ======= Термопринтер 58/80мм чек ======= */
        @media print {
          @page { margin: 0; size: 58mm auto; }
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          body { background: white; margin: 0; padding: 0; }
          body > *:not(.receipt-print) { display: none !important; }
          body > .receipt-print { display: block !important; }
        }

        .receipt-print {
          display: none;
          width: 48mm;
          padding: 2mm 2mm 2mm 2mm;
          font-family: 'Courier New', 'Lucida Console', monospace;
          font-size: 10px;
          line-height: 1.35;
          color: #000;
          background: #fff;
          word-wrap: break-word;
        }

        .receipt-print .rp-center { text-align: center; }
        .receipt-print .rp-bold { font-weight: 700; }
        .receipt-print .rp-large { font-size: 14px; }
        .receipt-print .rp-small { font-size: 8px; color: #666; }
        .receipt-print .rp-dash { border: none; border-top: 1px dashed #333; margin: 2mm 0; }
        .receipt-print .rp-thin { border: none; border-top: 1px solid #999; margin: 1.5mm 0; }
        .receipt-print .rp-row { display: flex; justify-content: space-between; }
        .receipt-print .rp-item-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 32mm; }
        .receipt-print .rp-total { font-size: 18px; font-weight: 700; text-align: center; margin: 2mm 0; }
        .receipt-print .rp-thanks { text-align: center; margin-top: 2mm; font-size: 10px; }
      `}</style>

      {/* Верхній колонтитул */}
      <div className="rp-center">
        <div className="rp-bold rp-large">{shopName}</div>
        <div className="rp-small">Магазин автозапчастин</div>
      </div>
      <hr className="rp-dash" />

      {/* Службова інформація */}
      <div className="rp-row">
        <span>Чек: #{sale.sale_number}</span>
        <span>{formatDateTime(sale.completed_at)}</span>
      </div>
      {sale.customer && (
        <div>Клієнт: {sale.customer.full_name ?? sale.customer.phone}</div>
      )}
      {sale.cashier_id && (
        <div>Касир: {sale.cashier_id.slice(0, 8)}</div>
      )}
      <hr className="rp-thin" />

      {/* Заголовок таблиці */}
      <div className="rp-row rp-bold rp-small">
        <span>Товар</span>
        <span>     Qty    Сума</span>
      </div>
      <hr className="rp-thin" />

      {/* Позиції */}
      {(sale.sale_items ?? []).map((item, i) => (
        <div key={i} style={{ marginBottom: '1mm' }}>
          <div className="rp-item-name">{item.product?.name ?? item.product_id}</div>
          <div className="rp-row">
            <span>{kopecksToHryvnia(item.unit_price)} ₴ × {item.qty} {item.product?.unit ?? 'шт'}</span>
            <span className="rp-bold">{kopecksToHryvnia(item.total)} ₴</span>
          </div>
          {item.discount > 0 && (
            <div className="rp-row rp-small">
              <span>знижка</span>
              <span>-{kopecksToHryvnia(item.discount)} ₴</span>
            </div>
          )}
        </div>
      ))}

      <hr className="rp-dash" />

      {/* Підсумок */}
      <div className="rp-row rp-bold">
        <span>РАЗОМ:</span>
        <span>{kopecksToHryvnia(sale.total)} ₴</span>
      </div>
      {sale.discount > 0 && (
        <div className="rp-row rp-small">
          <span>Знижка на чек</span>
          <span>-{kopecksToHryvnia(sale.discount)} ₴</span>
        </div>
      )}
      <div className="rp-row rp-small">
        <span>Оплата: {PAY_LABEL[sale.payment_method] ?? sale.payment_method}</span>
      </div>

      <hr className="rp-thin" />

      {/* Нижній колонтитул */}
      <div className="rp-thanks">
        <div className="rp-bold">Дякуємо за покупку!</div>
        <div className="rp-small" style={{ marginTop: '0.5mm' }}>
          Товар підлягає поверненню протягом 14 днів
        </div>
      </div>
    </div>
  )
}

export function printReceipt() {
  window.print()
}
