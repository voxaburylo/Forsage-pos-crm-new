import { createPortal } from 'react-dom'
import qrcode from 'qrcode-generator'
import type { Sale } from '@/types/sale'
import { kopecksToHryvnia } from '@/types/product'
import { formatDateTime } from '@/lib/utils'
import { PrintService } from '@/lib/printService'

// Синхронна генерація QR (SVG) — щоб був готовий одразу на момент друку
function qrSvg(text: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ cellSize: 2, margin: 0 })
}

interface Props {
  sale: Sale
  shopName?: string
  paperWidthMm?: 58 | 80
}

const PAY_LABEL: Record<string, string> = {
  cash: 'Готівка', card: 'Картка', debt: 'Борг', mixed: 'Змішано', transfer: 'Переказ',
}

export function ReceiptPrint({ sale, shopName = 'Форсаж', paperWidthMm }: Props) {
  const isOfflineReceipt = sale.sale_number.startsWith('OFF-')
  const savedWidth = Number(localStorage.getItem('forsage_receipt_width_mm'))
  const receiptWidth = paperWidthMm ?? (savedWidth === 80 ? 80 : 58)
  const sidePadding = receiptWidth === 80 ? 4 : 3
  const qrLink = `${window.location.origin}/sales?search=${encodeURIComponent(sale.sale_number)}`
  const qr = qrSvg(qrLink)
  return createPortal(
    <div className="receipt-print">
      <style>{`
        /* ======= Термопринтер 58/80мм чек ======= */
        @media print {
          @page { margin: 0; size: ${receiptWidth}mm auto; }
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          html, body { width: ${receiptWidth}mm !important; min-width: ${receiptWidth}mm !important; margin: 0 !important; padding: 0 !important; background: white; }
          body > *:not(.receipt-print) { display: none !important; }
          body > .receipt-print { display: block !important; }
        }

        .receipt-print {
          display: none;
          box-sizing: border-box;
          width: ${receiptWidth}mm;
          max-width: ${receiptWidth}mm;
          margin: 0;
          padding: 2mm ${sidePadding}mm 4mm;
          font-family: 'Courier New', 'Lucida Console', monospace;
          font-size: 10px;
          line-height: 1.35;
          color: #000;
          background: #fff;
          overflow: hidden;
          overflow-wrap: anywhere;
        }

        .receipt-print * { box-sizing: border-box; }
        .receipt-print .rp-center { text-align: center; }
        .receipt-print .rp-bold { font-weight: 700; }
        .receipt-print .rp-large { font-size: 14px; }
        .receipt-print .rp-small { font-size: 8px; color: #666; }
        .receipt-print .rp-dash { border: none; border-top: 1px dashed #333; margin: 2mm 0; }
        .receipt-print .rp-thin { border: none; border-top: 1px solid #999; margin: 1.5mm 0; }
        .receipt-print .rp-row { display: flex; justify-content: space-between; gap: 2mm; }
        .receipt-print .rp-row > :last-child { flex-shrink: 0; text-align: right; }
        .receipt-print .rp-item-name { white-space: normal; overflow-wrap: anywhere; }
        .receipt-print .rp-total { font-size: 18px; font-weight: 700; text-align: center; margin: 2mm 0; }
        .receipt-print .rp-thanks { text-align: center; margin-top: 2mm; font-size: 10px; }
        .receipt-print svg { display: block; width: 22mm; height: 22mm; margin: 0 auto; }
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

      {/* QR — швидке відкриття чека */}
      {isOfflineReceipt ? (
        <div className="rp-center rp-small" style={{ marginTop: '2mm' }}>
          НЕФІСКАЛЬНИЙ ОФЛАЙН-ЧЕК<br />
          Буде передано в систему після відновлення зв’язку
        </div>
      ) : (
        <div className="rp-center" style={{ marginTop: '2mm' }}>
          <div style={{ display: 'inline-block', width: '22mm', height: '22mm' }}
            dangerouslySetInnerHTML={{ __html: qr }} />
          <div className="rp-small">Скануйте, щоб відкрити чек</div>
        </div>
      )}

      {/* Нижній колонтитул */}
      <div className="rp-thanks">
        <div className="rp-bold">Дякуємо за покупку!</div>
        <div className="rp-small" style={{ marginTop: '0.5mm' }}>
          Товар підлягає поверненню протягом 14 днів
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function printReceipt() {
  PrintService.printCurrentPage()
}
