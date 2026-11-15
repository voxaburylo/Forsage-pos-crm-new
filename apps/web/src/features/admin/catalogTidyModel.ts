/** «Навести порядок» у каталозі: один підтверджений крок на кнопку. Перелік — лише перегляд. */
export type TidyStep = 'duplicates' | 'sku' | 'prices' | 'names' | 'garbage' | 'categories'
export interface TidyExample { name: string; before: string; after: string }
export interface TidyStepPlan { step: TidyStep; count: number; fingerprint: string; examples: TidyExample[] }
export interface TidyPlan {
  steps: TidyStepPlan[]
  info: { lost_thousands: number; zero_or_below_cost: number; uncategorized_left: number; manual_duplicate_groups: number; garbage_kept: number }
}
export interface TidyResult { step: TidyStep; changed: number; skipped: Array<{ name: string; reason: string }>; backupPath?: string }
export interface TidyApplyInput { step: TidyStep; operation_id: string; fingerprint: string }

export const tidyStepText: Record<TidyStep, { title: string; what: string; done: string }> = {
  duplicates: {
    title: 'Об’єднати точні дублі',
    what: 'Картки з однаковою назвою стають однією. Ціна — більша з карток, облікові залишки складаються, історія продажів і штрихкоди зберігаються.',
    done: 'груп об’єднано',
  },
  sku: {
    title: 'Перенести артикули з назв',
    what: 'Якщо в назві є номер виробника, а поле артикулу порожнє, номер копіюється в артикул. Заповнені вручну артикули не змінюються.',
    done: 'артикулів записано',
  },
  prices: {
    title: 'Округлити ціни без копійок',
    what: 'Ціна продажу з копійками округлюється вгору до 5 грн, ціни до 10 грн — до цілої гривні. Закупівельні ціни не змінюються.',
    done: 'цін округлено',
  },
  names: {
    title: 'Прибрати зайві пробіли в назвах',
    what: 'Подвійні пробіли та пробіли по краях. Самі слова в назві не змінюються.',
    done: 'назв виправлено',
  },
  garbage: {
    title: 'Видалити сміттєві картки',
    what: 'Картки з назвою на кшталт «1» або кодом замість назви — лише ті, де немає залишку й жодного документа.',
    done: 'карток видалено',
  },
  categories: {
    title: 'Розкласти товари без категорії',
    what: 'Товар без категорії потрапляє туди, де вже лежать товари з таким самим початком назви. Дублі назв категорій об’єднуються, порожні прибираються.',
    done: 'змін у категоріях',
  },
}

/** Рядки «для відома»: що власник вирішив не виправляти автоматично. */
export function tidyInfoLines(info: TidyPlan['info']): string[] {
  const lines: string[] = []
  if (info.lost_thousands) lines.push(`Ціни на кшталт 1,09 грн при закупівлі від 100 грн: ${info.lost_thousands}. Не змінюються — перевірте вручну.`)
  if (info.zero_or_below_cost) lines.push(`Ціна 0 або нижча за закупівельну: ${info.zero_or_below_cost}. Не змінюються.`)
  if (info.manual_duplicate_groups) lines.push(`Імовірних дублів із різними назвами: ${info.manual_duplicate_groups}. Перегляньте їх у списку нижче.`)
  if (info.uncategorized_left) lines.push(`Товарів, для яких категорію визначити не вдалося: ${info.uncategorized_left}.`)
  if (info.garbage_kept) lines.push(`Сміттєвих карток із залишком або документами: ${info.garbage_kept}. Не видаляються.`)
  return lines
}

export function tidyResultText(result: TidyResult): string {
  const text = tidyStepText[result.step]
  return `${text.title}: ${result.changed} ${text.done}` + (result.skipped.length ? `, пропущено ${result.skipped.length}` : '') + '.'
}

/** Повтор після втраченої відповіді має піти з тим самим номером операції, інший крок — з новим. */
export function retainTidyOperation(pending: TidyApplyInput | null, step: TidyStep, fingerprint: string, makeId = () => crypto.randomUUID()): TidyApplyInput {
  return pending && pending.step === step && pending.fingerprint === fingerprint ? pending : { step, fingerprint, operation_id: makeId() }
}
