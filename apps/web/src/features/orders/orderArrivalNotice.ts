import { PrintService } from '@/lib/printService'

/**
 * 23.11.2026 (план C3): повідомлення клієнту «замовлення прибуло» і наклейка на товар.
 * Повідомлення не відправляється саме: касир копіює текст або відкриває Viber/SMS з номером клієнта.
 */

/** Український номер у вигляді +380XXXXXXXXX; інше (короткий, чужий, порожній) — null, щоб не писати не туди. */
export function ukrainianPhone(raw: string | null | undefined): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '')
  const full = digits.length === 12 && digits.startsWith('380') ? digits
    : digits.length === 10 && digits.startsWith('0') ? '38' + digits
      : digits.length === 9 ? '380' + digits
        : null
  return full ? '+' + full : null
}

export function arrivalMessage(input: { order_number: number; customer_name?: string | null; complete: boolean }, shopName = 'Форсаж'): string {
  const name = input.customer_name?.trim()
  const greeting = name ? `Добрий день, ${name}!` : 'Добрий день!'
  return input.complete
    ? `${greeting} Ваше замовлення № ${input.order_number} прибуло в магазин «${shopName}». Можна забирати.`
    : `${greeting} Частина вашого замовлення № ${input.order_number} прибула в магазин «${shopName}». Решту чекаємо — повідомимо.`
}

/** Посилання для Viber (відкриває чат із номером) і SMS (на телефоні — з готовим текстом). */
export function arrivalLinks(phone: string | null | undefined, message: string): { viber: string; sms: string } | null {
  const number = ukrainianPhone(phone)
  if (!number) return null
  return {
    viber: 'viber://chat?number=' + encodeURIComponent(number),
    sms: 'sms:' + number + '?body=' + encodeURIComponent(message),
  }
}

export interface OrderLabel {
  order_number: number
  customer_name: string | null
  customer_phone: string | null
  items: Array<{ name: string; qty: number }>
}

const quantity = (value: number) => Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)))

/**
 * Наклейка на пришедший товар: номер замовлення, імʼя, телефон і що це — щоб на полиці було видно, чий товар.
 * Розмір — як у цінника з налаштувань етикеток; друкується тим самим шляхом (printLabelDocument).
 */
export function buildOrderLabelDocument(labels: readonly OrderLabel[], size: { width_mm?: number; height_mm?: number } = {}) {
  if (!labels.length) throw new Error('Немає наклейок для друку.')
  const w = Math.max(30, Math.min(120, Number(size.width_mm) || 58))
  const h = Math.max(20, Math.min(100, Number(size.height_mm) || 40))
  const esc = PrintService.escapeHtml
  const pages = labels.map((label, index) => {
    const items = label.items.map(item => `${item.name} × ${quantity(item.qty)}`).join('; ')
    return `<section class="label-page${index < labels.length - 1 ? ' has-next' : ''}"><div class="label-content">
      <div class="no">Замовлення № ${esc(String(label.order_number))}</div>
      <div class="name">${esc(label.customer_name?.trim() || 'Клієнт без імені')}</div>
      <div class="phone">${esc(label.customer_phone?.trim() || '')}</div>
      <div class="items">${esc(items)}</div>
    </div></section>`
  }).join('')
  const html = `<!DOCTYPE html>
<html lang="uk"><head><meta charset="utf-8"><title>Наклейки замовлень ${w}×${h} мм</title><style>
  @page { margin: 0; size: ${w}mm ${h}mm; }
  html, body { margin: 0 !important; padding: 0 !important; width: ${w}mm; background: #fff; }
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: Arial, sans-serif; color: #000; }
  .label-page { display: block; position: relative; width: ${w}mm; height: ${h}mm; padding: 1.5mm; overflow: hidden; break-inside: avoid; page-break-inside: avoid; }
  .label-page.has-next { break-after: page; page-break-after: always; }
  .label-content { width: 100%; height: 100%; overflow: hidden; display: flex; flex-direction: column; gap: .6mm; }
  .no { font-size: 9pt; font-weight: 700; }
  .name { font-size: 13pt; font-weight: 700; line-height: 1.05; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .phone { font-size: 11pt; font-weight: 700; font-family: 'Courier New', monospace; }
  .items { font-size: 7pt; line-height: 1.1; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
</style></head><body>${pages}</body></html>`
  return { html, title: `Наклейки замовлень ${w}×${h} мм`, widthMm: w, heightMm: h, count: labels.length }
}
