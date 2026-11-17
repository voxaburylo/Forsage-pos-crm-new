/**
 * Постійні коди причин, чому накладну не провели. Код і номер рядка безпечно
 * писати в журнал проблем: у них немає назв товарів, артикулів, цін чи людей.
 * Повний текст із назвами бачить лише касир під рядком накладної.
 */
export const RECEIVING_LINE_REASONS: Record<string, string> = {
  'duplicate-in-invoice': 'Той самий штрихкод або артикул стоїть у двох різних товарах цієї накладної',
  'identifier-several-cards': 'Артикул і штрихкод рядка належать різним карткам у базі',
  'identifier-other-card': 'Артикул або штрихкод рядка належить іншій картці, ніж вибрана',
  'identifier-taken': 'Артикул або штрихкод уже зайнятий іншою карткою',
  'selected-card-deleted': 'Вибрану картку товару видалено',
  'sku-deleted-card': 'Артикул має лише видалена картка без живої заміни',
  'name-several-cards': 'Кілька карток мають точно таку саму назву',
  'card-inactive': 'Картка неактивна або є послугою',
  'card-changed': 'Картку товару змінили, поки накладна була відкрита',
  'stale-draft': 'Стара чернетка без версії картки',
  'ai-existing-card': 'Для рядка знайдено наявну картку, а вибрано іншу',
  'deleted-reference': 'Категорію або інший реквізит видалено',
  'missing-name': 'Рядок без назви товару',
  'category-name': 'Задовга назва нової папки',
  'line-key': 'Пошкоджений ідентифікатор рядка',
  'line-validation': 'Кількість, ціна або сума рядка не пройшли перевірку',
}

export const RECEIVING_STEPS: Record<string, string> = {
  'invoice-save': 'запис документа',
  payment: 'оплата постачальнику',
  posting: 'проведення залишків',
}

const LINE_PATTERNS: Array<[RegExp, string]> = [
  [/вже є в рядку/, 'duplicate-in-invoice'],
  [/належать різним карткам/, 'identifier-several-cards'],
  [/належить іншому товару/, 'identifier-other-card'],
  [/уже зайнятий/, 'identifier-taken'],
  [/Вибраний товар видалено/, 'selected-card-deleted'],
  [/має видалена картка/, 'sku-deleted-card'],
  [/кілька товарів із точною назвою/, 'name-several-cards'],
  [/неактивний або є послугою/, 'card-inactive'],
  [/Картка товару змінилася/, 'card-changed'],
  [/Стара чернетка/, 'stale-draft'],
  [/Знайдено наявну картку/, 'ai-existing-card'],
  [/Категорію видалено|Категорію або інший реквізит/, 'deleted-reference'],
  [/Вкажіть назву товару/, 'missing-name'],
  [/Назва папки/, 'category-name'],
  [/ідентифікатор рядка/, 'line-key'],
]

export function receivingLineReason(message: string): string {
  return LINE_PATTERNS.find(([pattern]) => pattern.test(message))?.[1] ?? 'line-validation'
}

const LINE_MARKER = /RECEIVING_LINE:(\d+):([a-z-]+):/
const STEP_MARKER = /RECEIVING_STEP:([a-z-]+):/

/** Безпечний опис для журналу або null, якщо це не помилка проведення накладної. */
export function receivingProblemDetail(text: string): { code: string; explanation: string } | null {
  const line = LINE_MARKER.exec(text)
  if (line && Object.hasOwn(RECEIVING_LINE_REASONS, line[2])) {
    return { code: 'receiving-' + line[2], explanation: `Проведення накладної, рядок ${Number(line[1]) + 1}: ${RECEIVING_LINE_REASONS[line[2]]}` }
  }
  const step = STEP_MARKER.exec(text)
  if (step && Object.hasOwn(RECEIVING_STEPS, step[1])) {
    return { code: 'receiving-step-' + step[1], explanation: `Проведення накладної: збій на кроці «${RECEIVING_STEPS[step[1]]}»` }
  }
  return null
}

/** Розпізнає вже збережений опис, щоб повторне читання журналу його не затерло. */
export function isStoredReceivingDetail(explanation: string, code: string): boolean {
  if (code.startsWith('receiving-step-')) {
    const step = code.slice('receiving-step-'.length)
    return Object.hasOwn(RECEIVING_STEPS, step) && explanation.startsWith(`Проведення накладної: збій на кроці «${RECEIVING_STEPS[step]}»`)
  }
  const reason = code.slice('receiving-'.length)
  if (!code.startsWith('receiving-') || !Object.hasOwn(RECEIVING_LINE_REASONS, reason)) return false
  return new RegExp(`^Проведення накладної, рядок \\d+: `).test(explanation) && explanation.endsWith(RECEIVING_LINE_REASONS[reason])
}
