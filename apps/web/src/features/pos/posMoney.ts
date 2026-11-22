/** Prices and line amounts are kopecks. Round each line exactly as local checkout does. */
export function posLineGross(unitPrice: number, qty: number): number {
  return Math.max(0, Math.round(unitPrice * qty))
}

/** Закупівельна вартість рядка в копійках; 0 — закупівельна ціна невідома, обмеження немає. */
export function posLineCost(item: { qty: number; purchasePrice?: number }): number {
  const purchase = Number(item.purchasePrice)
  return Number.isFinite(purchase) && purchase > 0 ? posLineGross(Math.round(purchase), item.qty) : 0
}

/** Крок округлення ціни після знижки клієнта: 5 грн у копійках. */
export const DISCOUNT_ROUND_KOPECKS = 500

export function posLineAmounts(item: { unitPrice: number; qty: number; discount: number; discountPct?: number; purchasePrice?: number }) {
  const gross = posLineGross(item.unitPrice, item.qty)
  // 22.11.2026: 100 % — це «працівнику за закупкою». Коли закупівельна ціна рядка невідома (послуга, стара картка),
  // така знижка зробила б його безкоштовним, тому на цей рядок вона не діє зовсім.
  const atCostWithoutCost = item.discountPct !== undefined && item.discountPct >= 100 && posLineCost(item) <= 0
  const pct = item.discountPct !== undefined && Number.isFinite(item.discountPct) ? Math.max(0, Math.min(100, item.discountPct)) : undefined
  // 22.11.2026 (рішення власника): ціна після знижки клієнта округлюється вгору до цілих 5 грн — знижка лише менша,
  // ціна не вища за повну. «За закупкою» (100 %) і ручна знижка сумою не округлюються.
  const requested = atCostWithoutCost ? 0 : pct !== undefined
    ? Math.round(gross * pct / 100)
    : Math.round(Number.isFinite(item.discount) ? item.discount : 0)
  // Правило магазину: товар не відпускається нижче закупівельної ціни, тому
  // будь-яка знижка (клієнта, працівника, ручна) зупиняється на собівартості.
  const roomAboveCost = Math.max(0, gross - posLineCost(item))
  const floored = Math.max(0, Math.min(gross, roomAboveCost, requested))
  if (!(pct !== undefined && pct > 0 && pct < 100) || floored === 0) return { discount: floored, total: gross - floored }
  // Округлюємо вже після межі закупки: ціна лише зростає, тож нижче закупки не опуститься.
  const total = Math.min(gross, Math.ceil((gross - floored) / DISCOUNT_ROUND_KOPECKS) * DISCOUNT_ROUND_KOPECKS)
  return { discount: gross - total, total }
}

/** Чому касі не можна додати цей товар у чек; null — можна. */
export function posSaleBlockReason(item: { name: string; unitPrice: number; purchasePrice?: number }): string | null {
  if (!(Number(item.unitPrice) > 0)) return `У товару «${item.name}» немає ціни продажу. Вкажіть ціну в картці товару.`
  const purchase = Number(item.purchasePrice)
  if (Number.isFinite(purchase) && purchase > 0 && item.unitPrice < Math.round(purchase)) {
    return `«${item.name}»: ціна продажу нижча за закупівельну. Продаж заборонено — оновіть ціну товару.`
  }
  return null
}

/** Останні 9 цифр телефону: 0671112233 і +380671112233 — той самий номер. */
export function posPhoneKey(phone: string | null | undefined): string {
  const digits = String(phone ?? '').replace(/\D/g, '')
  return digits.length >= 9 ? digits.slice(-9) : ''
}

export function posCoreTotal(item: { qty: number; requiresCoreReturn?: boolean; coreDepositAmount?: number }) {
  return item.requiresCoreReturn ? posLineGross(Math.round(item.coreDepositAmount ?? 0), item.qty) : 0
}
