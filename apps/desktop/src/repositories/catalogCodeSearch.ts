/**
 * Пошук товару за кодом без огляду на розділювачі (27.11.2026, слово власника: «не зрозуміло, чи працюють на касі всі
 * крос-номери»). Перевірка на копії бази показала: крос-номер знаходився лише тоді, коли його набрали точно як у картці —
 * «26300-35500» знаходило, «2630035500» і «26300 35500» — ні; так само артикул із назви «W811/80» не знаходився як
 * «w81180». Половина крос-номерів каси (5 638 з 11 742) має дефіс, пробіл, крапку чи слеш.
 * Тепер код порівнюється «стиснутим»: лише літери й цифри, без регістру.
 */
export const CODE_MIN_LENGTH = 4
/** Від цієї довжини стиснутий код шукаємо ще й у тексті картки (назва, артикул, штрихкоди) без пробілів. */
export const CODE_TEXT_MIN_LENGTH = 5

/** Стиснутий код: лише літери й цифри, великими. */
export function looseCode(value: string | null | undefined): string {
  return String(value ?? '').normalize('NFKC').toLocaleUpperCase('uk-UA').replace(/[^A-ZА-ЯІЇЄҐ0-9]/g, '')
}

/** Те саме стиснення в SQL (розділювачі, якими пишуть артикули й крос-номери). */
export const sqlLooseCode = (column: string) =>
  `upper(replace(replace(replace(replace(replace(replace(${column}, ' ', ''), '-', ''), '/', ''), '.', ''), '_', ''), ',', ''))`

/**
 * Чи схожий запит на один код: є цифра, немає кирилиці, стиснутий — від 4 знаків.
 * «фільтр w811» — це слова, а не код: для нього діє звичайний пошук за словами.
 */
export function queryAsCode(raw: string): string | null {
  const text = String(raw ?? '').trim()
  if (!text || /[А-Яа-яІЇЄҐіїєґЁёЫыЭэЪъ]/.test(text)) return null
  const code = looseCode(text)
  return code.length >= CODE_MIN_LENGTH && /\d/.test(code) ? code : null
}

/** Додаткові умови пошуку (через OR з рештою) і їхні параметри. Порожньо — запит не схожий на код. */
export function codeSearchClauses(raw: string, tenantId: string): { clauses: string[]; params: string[] } {
  const code = queryAsCode(raw)
  if (!code) return { clauses: [], params: [] }
  const clauses = [
    `${sqlLooseCode('p.sku')} = ?`,
    `p.id IN (
          SELECT x.product_id FROM product_cross_numbers x
          WHERE x.tenant_id = ?
            AND x.deleted_at IS NULL
            AND ${sqlLooseCode('x.cross_number')} = ?
        )`,
  ]
  const params = [code, tenantId, code]
  if (code.length >= CODE_TEXT_MIN_LENGTH) {
    // Текст картки для пошуку зберігається малими літерами, слова через пробіл: «w811 80» → «w81180».
    clauses.push("replace(p.search_text, ' ', '') LIKE ?")
    params.push(`%${code.toLocaleLowerCase('uk-UA')}%`)
  }
  return { clauses, params }
}
