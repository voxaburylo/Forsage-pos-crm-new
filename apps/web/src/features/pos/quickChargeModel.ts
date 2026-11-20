/** Скільки окремих рядків «Вільний продаж» може бути в одному чеку. */
export const FREE_SALE_MAX_LINES = 9

export function freeSaleSku(index: number): string {
  return index <= 1 ? 'POS-FREE-SALE' : `POS-FREE-SALE-${index}`
}

export function freeSaleName(index: number): string {
  return index <= 1 ? 'Вільний продаж' : `Вільний продаж ${index}`
}

/**
 * Номер службової позиції для наступної «вільної суми» (20.11.2026: друга сума замінювала першу —
 * шини 19 600 ставали рукавичками 100 грн). Кожна сума — окремий рядок; null, коли всі 9 уже в чеку.
 */
export function nextFreeSaleIndex(skusInReceipt: Iterable<string>): number | null {
  const used = new Set(skusInReceipt)
  for (let index = 1; index <= FREE_SALE_MAX_LINES; index++) {
    if (!used.has(freeSaleSku(index))) return index
  }
  return null
}

/** Назва рядка в чеку: «Вільний продаж: рукавички», щоб касир розрізняв рядки. */
export function freeSaleLineName(baseName: string, description: string): string {
  const text = description.replace(/\s+/g, ' ').trim()
  return text ? `${baseName}: ${text}`.slice(0, 120) : baseName
}
