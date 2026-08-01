import { createPortal } from 'react-dom'
import qrcode from 'qrcode-generator'
import type { Sale } from '@/types/sale'
import { kopecksToHryvnia } from '@/types/product'
import { formatDateTime } from '@/lib/utils'
import { PrintService } from '@/lib/printService'
import { SingleFlight } from '@/lib/singleFlight'
import { toast } from '@/components/ui/Toast'
import { resolveReceiptPrinter } from './receiptPrinterSettings'

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
  shopAddress?: string
  shopPhone?: string
  sellerName?: string
  paperWidthMm?: 58 | 80
}

const PAY_LABEL: Record<string, string> = {
  cash: 'Готівка', card: 'Картка', debt: 'Борг', mixed: 'Змішано', transfer: 'Переказ',
}

function cached(key: string): string {
  try { return localStorage.getItem(key) ?? '' } catch { return '' }
}

export function ReceiptPrint({ sale, shopName, shopAddress, shopPhone, sellerName, paperWidthMm }: Props) {
  const isOfflineReceipt = sale.sale_number.startsWith('OFF-')
  const savedWidth = Number(localStorage.getItem('forsage_receipt_width_mm'))
  const receiptWidth = paperWidthMm ?? (savedWidth === 80 ? 80 : 58)
  // Офлайн-безпечно: якщо пропси не передані, беремо з кешу localStorage
  const name = shopName || cached('forsage_shop_name') || 'Форсаж'
  const address = shopAddress ?? cached('forsage_shop_address')
  const phone = shopPhone ?? cached('forsage_shop_phone')
  const seller = sellerName || sale.manager?.full_name || cached('forsage_seller_name')
  const sidePadding = receiptWidth === 80 ? 4 : 3
  const fiscalQrUrl = typeof sale.fiscal_qr_url === 'string' ? sale.fiscal_qr_url.trim() : ''
  const fiscalQr = fiscalQrUrl ? qrSvg(fiscalQrUrl) : ''
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
          /* Термопринтер друкує лише чистий чорний; сірі відтінки він дизерить
             у крапки — виходить «брудно». Тому все чорне і жирнувате, а шрифт
             більший, бо на 10px чек майже не читався. */
          font-size: 13px;
          font-weight: 700;
          line-height: 1.4;
          color: #000;
          background: #fff;
          overflow: hidden;
          overflow-wrap: anywhere;
        }

        .receipt-print * { box-sizing: border-box; }
        .receipt-print .rp-center { text-align: center; }
        .receipt-print .rp-bold { font-weight: 700; }
        .receipt-print .rp-large { font-size: 17px; }
        .receipt-print .rp-small { font-size: 11px; color: #000; }
        .receipt-print .rp-dash { border: none; border-top: 1px dashed #000; margin: 2mm 0; }
        .receipt-print .rp-thin { border: none; border-top: 1px solid #000; margin: 1.5mm 0; }
        .receipt-print .rp-row { display: flex; justify-content: space-between; gap: 2mm; }
        .receipt-print .rp-row > :last-child { flex-shrink: 0; text-align: right; }
        .receipt-print .rp-item-name { white-space: normal; overflow-wrap: anywhere; }
        .receipt-print .rp-total { font-size: 22px; font-weight: 700; text-align: center; margin: 2mm 0; }
        .receipt-print .rp-thanks { text-align: center; margin-top: 2mm; font-size: 13px; }
        .receipt-print svg { display: block; width: 22mm; height: 22mm; margin: 0 auto; }
      `}</style>

      {/* Верхній колонтитул */}
      <div className="rp-center">
        <div className="rp-bold rp-large">{name}</div>
        <div className="rp-small">Магазин автозапчастин</div>
        {address && <div className="rp-small">{address}</div>}
        {phone && <div className="rp-small">тел. {phone}</div>}
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
      {seller && (
        <div>Продавець: {seller}</div>
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

      {/* QR фіскального чека */}
      {isOfflineReceipt ? (
        <div className="rp-center rp-small" style={{ marginTop: '2mm' }}>
          НЕФІСКАЛЬНИЙ ОФЛАЙН-ЧЕК<br />
          Буде передано в систему після відновлення зв’язку
        </div>
      ) : fiscalQr ? (
        <div className="rp-center" style={{ marginTop: '2mm' }}>
          <div style={{ display: 'inline-block', width: '22mm', height: '22mm' }}
            dangerouslySetInnerHTML={{ __html: fiscalQr }} />
          <div className="rp-small">Фіскальний чек</div>
        </div>
      ) : (
        <div className="rp-center rp-small" style={{ marginTop: '2mm' }}>
          QR фіскального чека ще не отримано
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

/** Людське пояснення для кодів охорони черги друку (див. spoolerGuard). */
function receiptPrintErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  if (raw.includes('PRINT_QUEUE_STUCK')) {
    return 'У черзі чекового принтера залипло старе завдання, і Windows не дає його прибрати. '
      + 'Перезапустіть службу «Диспетчер друку» (Спулер) або комп’ютер.'
  }
  if (raw.includes('PRINT_PRINTER_NOT_READY') || raw.includes('PRINT_NOT_CONFIRMED')) {
    return 'Чековий принтер не готовий: перевірте живлення, USB-кабель і наявність паперу. Чек НЕ надруковано.'
  }
  if (raw.includes('PRINT_RECEIPT_PRINTER_NOT_SET') || raw.includes('PRINT_RECEIPT_PRINTER_MISMATCH')) {
    return 'Чековий принтер POS-58 не знайдено. Чек не буде перенаправлено на принтер етикеток POS-80.'
  }
  if (raw.includes('PRINT_OUTCOME_UNKNOWN')) {
    return 'Windows не підтвердила результат друку. Не запускайте чек повторно автоматично: перевірте принтер і чергу друку.'
  }
  if (raw.includes('PRINT_RENDER_TIMEOUT') || raw.includes('PRINT_RESOURCES_TIMEOUT')) {
    return 'Чек не вдалося підготувати до друку вчасно. Повторний прихований друк не запускався.'
  }
  return ''
}

const receiptPrintFlight = new SingleFlight<void>()

export function printReceipt() {
  // Повторне натискання, авто-друк і ручна кнопка ділять одне живе завдання.
  if (receiptPrintFlight.isActive) return

  void receiptPrintFlight.run(async () => {
    try {
      const desktopPrint = typeof window !== 'undefined' ? window.forsageDesktop?.print : undefined
      if (!desktopPrint) {
        PrintService.printCurrentPage()
        return
      }

      const el = document.querySelector('.receipt-print')
      if (!el) throw new Error('PRINT_RECEIPT_NOT_READY')
      const html = `<!DOCTYPE html><html lang="uk"><head><meta charset="utf-8">`
        + `<style>@page{margin:0}html,body{margin:0;padding:0;background:#fff}`
        + `.receipt-print{display:block !important}</style></head><body>`
        + `${el.outerHTML}</body></html>`
      const deviceName = await resolveReceiptPrinter()
      if (!deviceName) throw new Error('PRINT_RECEIPT_PRINTER_NOT_SET')

      await desktopPrint.html(html, {
        title: 'Чек',
        silent: true,
        deviceName,
        printerRole: 'receipt',
        useDriverPaper: true,
      })
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error ?? '')
      // Скасування користувачем — завершена дія, а не привід відкривати друге
      // вікно або показувати помилку.
      if (raw.includes('PRINT_CANCELLED')) return
      console.error('Native receipt print failed', error)
      const explained = receiptPrintErrorMessage(error)
      toast.error(explained || 'Чек не надруковано. Автоматичний повторний друк не запускався.')
    }
  })
}
