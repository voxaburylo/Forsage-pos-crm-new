/**
 * Що вставили в поле помічника: таблицю (Excel/сайт постачальника — розбирається як прихід)
 * чи звичайний текст (інструкція, питання). 18.11.2026: багаторядкова інструкція власнику
 * прикріплювалась як «таблиця» і помічник шукав у ній накладну.
 */
export function isPastedTable(text: string, invoiceMode = false): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (invoiceMode) return true
  if (trimmed.includes('\t')) return true
  const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length < 2) return false
  // Список товарів текстом (з месенджера): кілька рядків із цінами «141 грн», «2.50 $».
  const priced = lines.filter(line => /\d(?:[\d\s]*[.,]?\d+)?\s*(?:грн|uah|₴|\$|usd|дол)/iu.test(line)).length
  if (priced >= 2) return true
  // CSV/«|»-таблиця: щонайменше два рядки з однаковою кількістю (≥ 2) роздільників.
  for (const separator of [';', '|']) {
    const counts = lines.map(line => line.split(separator).length - 1).filter(count => count >= 2)
    if (counts.length >= 2 && counts.filter(count => count === counts[0]).length >= Math.max(2, Math.ceil(counts.length * 0.6))) return true
  }
  return false
}
