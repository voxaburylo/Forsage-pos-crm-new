/**
 * 23.11.2026 (план B2): пачки штрихкодів для карток клієнтів — для друкарні.
 * Коди видає і зберігає головний ПК (перевірка по клієнтах, товарах і раніше виданих пачках); тут — лише екран.
 */
export type CardFormat = 'ean13' | 'digits10'
export const CARD_BATCH_MAX = 5000
export const CARD_COUNT_PRESETS = [100, 500, 1000] as const
export const FREE_CARD_EVENT = 'forsage:free-card-scanned'

export const CARD_FORMATS: ReadonlyArray<{ id: CardFormat; label: string; hint: string }> = [
  { id: 'ean13', label: '13 цифр з окремим початком', hint: 'Початок «29» — не перетинається зі штрихкодами товарів. Читається будь-яким сканером.' },
  { id: 'digits10', label: '10 цифр, як старі картки', hint: 'Початок «77». Якщо друкарня вже має макет під 10 цифр.' },
]

export const cardFormatLabel = (format: string) => CARD_FORMATS.find(item => item.id === format)?.label ?? format

/** Кількість із поля: ціле число від 1 до межі; інакше — пояснення для людини. */
export function parseCardCount(text: string): { count: number } | { error: string } {
  const clean = text.trim().replace(/\s/g, '')
  if (!/^\d{1,6}$/.test(clean)) return { error: 'Вкажіть, скільки карток потрібно, — цілим числом' }
  const count = Number(clean)
  if (count < 1) return { error: 'Потрібна хоча б одна картка' }
  if (count > CARD_BATCH_MAX) return { error: `За один раз — не більше ${CARD_BATCH_MAX} карток` }
  return { count }
}

/** Стовпчик кодів — як просить друкарня: один код у рядку, без заголовків і пробілів. */
export const cardCodesText = (codes: readonly string[]) => codes.join('\n')

/**
 * Таблиця для Excel. Коди — текстом, а не числом: Excel інакше покаже 13 цифр як «2,9E+12»
 * і друкарня надрукує не той код.
 */
export function cardCodesSheet(codes: readonly string[]): Array<Array<{ t: 's'; v: string; z: '@' }>> {
  return codes.map(code => [{ t: 's' as const, v: code, z: '@' as const }])
}

export function cardBatchFileName(createdAt: string, count: number): string {
  const day = /^\d{4}-\d{2}-\d{2}/.test(createdAt) ? createdAt.slice(0, 10) : 'пачка'
  return `Картки-клієнтів-${day}-${count}шт.xlsx`
}

/** Код картки з адреси (новий клієнт із вільною карткою): лише цифри. */
export function cardCodeFromParam(value: string | null | undefined): string {
  const code = String(value ?? '').replace(/\s/g, '')
  return /^\d{8,14}$/.test(code) ? code : ''
}

export const newCustomerWithCardPath = (code: string) => `/customers/new?card=${encodeURIComponent(code)}`
