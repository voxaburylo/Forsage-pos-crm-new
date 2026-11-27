import { toast } from '@/components/ui/Toast'
import { isDesktopRuntime } from '@/lib/desktopBridge'

/**
 * 27.11.2026, завдання власника: каса не дає продати заброньоване й показує «Товар у замовленні №… (сайт, оплачено)»
 * з кнопкою відкрити це замовлення. Каса додає в текст помилки мітку [order:<id>] — тут її прибираємо з тексту
 * й робимо з неї кнопку.
 */
const ORDER_TAG = /\s*\[order:([0-9a-f-]{36})\]/i

export function splitReservedOrder(message: string): { text: string; orderId: string | null } {
  const found = ORDER_TAG.exec(message)
  return { text: message.replace(ORDER_TAG, ''), orderId: found ? found[1] : null }
}

function openOrder(orderId: string): void {
  // Каса — адреси через «#», веб — звичайні; роутер слухає зміну адреси й відкриває замовлення без перезавантаження.
  if (isDesktopRuntime()) { window.location.hash = `#/orders/${orderId}`; return }
  window.history.pushState(null, '', `/orders/${orderId}`)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/** Показати помилку продажу; якщо товар у замовленні — з кнопкою «Відкрити замовлення». */
export function showSaleError(message: string): void {
  const { text, orderId } = splitReservedOrder(message)
  toast.error(text, orderId ? { label: 'Відкрити замовлення', onClick: () => openOrder(orderId) } : undefined)
}
