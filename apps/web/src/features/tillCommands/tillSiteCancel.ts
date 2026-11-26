/**
 * Замовлення скасували на сайті (27.11.2026). Каса скасовує своє замовлення сама лише тоді, коли це безпечно:
 * у ньому ще немає грошей і його не видали. Інакше — відмова з причиною: гроші й видачу вирішує людина на касі.
 */
export const SITE_CANCEL_REASON = 'Скасовано на сайті'

export interface SiteCancelOrder { status?: string | null; prepayment?: number | null; total_paid?: number | null }
export type SiteCancelPlan = { action: 'cancel' | 'nothing' | 'refuse'; reason: string }

export function siteCancelPlan(order: SiteCancelOrder | null | undefined): SiteCancelPlan {
  if (!order) return { action: 'refuse', reason: 'Замовлення із сайту не знайдено на касі — скасуйте його вручну, якщо воно є.' }
  const status = String(order.status ?? '')
  if (status === 'canceled' || status === 'archived') return { action: 'nothing', reason: 'Замовлення вже скасоване на касі.' }
  if (status === 'completed') return { action: 'refuse', reason: 'Покупець скасував замовлення на сайті, але на касі його вже видано. Перевірте й оформіть повернення вручну.' }
  if ((Number(order.prepayment) || 0) > 0 || (Number(order.total_paid) || 0) > 0)
    return { action: 'refuse', reason: 'Покупець скасував замовлення на сайті, але в ньому є оплата. Скасуйте на касі вручну й вирішіть, що з грошима.' }
  return { action: 'cancel', reason: SITE_CANCEL_REASON }
}
