/**
 * Розкладка товарів постачальника по НАШИХ категоріях (рішення власника 24.11.2026).
 * У прайсі Омеги категорій немає — лише назва. Тип товару — перші слова назви («Фільтр повітряний …», «Трос ручного …»).
 * Програма вчиться на наших картках: якщо картки з таким типом здебільшого лежать в одній категорії — туди ж і товар
 * постачальника. Невпевнене лишається БЕЗ категорії (власник розкладе сам). Мова не заважає: українські й російські
 * написання зводяться до одного вигляду, а для частих розбіжностей є короткий словник.
 */

/** Одна «абетка» для двох мов: і/ї/и/ы → и, є/е/э/ё → е, ґ → г; лише літери. */
export function foldWord(word: string): string {
  return word.toLowerCase().replace(/[ії]/g, 'и').replace(/ы/g, 'и').replace(/[єэё]/g, 'е').replace(/ґ/g, 'г').replace(/[ʼ'’`]/g, '').replace(/[^\p{L}]/gu, '')
}

/**
 * Різні слова для того самого (після foldWord). Лише безспірні пари назв типу товару; бренди й моделі сюди не входять.
 */
export const TYPE_SYNONYMS: Readonly<Record<string, string>> = {
  пильовик: 'пильник', пильовики: 'пильник', пильник: 'пильник',
  важил: 'ричаг', важиль: 'ричаг', ричаг: 'ричаг',
  стийка: 'стойка', стойка: 'стойка',
  шркш: 'шрус', шрус: 'шрус',
  накинечник: 'наконечник', наконечник: 'наконечник',
  маточина: 'ступица', ступица: 'ступица',
  вкладиши: 'вкладиши', вкладиш: 'вкладиши',
  зчеплення: 'сцепление', сцепление: 'сцепление', зчепления: 'сцепление',
  натяжний: 'натяжной', натяжнии: 'натяжной', натяжной: 'натяжной',
  циліндр: 'цилиндр', цилиндр: 'цилиндр',
  фильтр: 'фильтр', филтр: 'фильтр',
  ремин: 'ремень', ремень: 'ремень', ремінь: 'ремень',
  свичка: 'свеча', свича: 'свеча', свеча: 'свеча',
  гальмивна: 'тормозная', гальмивнии: 'тормозной', гальмивни: 'тормозние', гальм: 'тормоз',
  колодка: 'колодка', колодки: 'колодка',
  подушка: 'подушка', опора: 'опора', втулка: 'втулка', тяга: 'тяга', пружина: 'пружина', насос: 'насос', шланг: 'шланг', клапан: 'клапан',
  амортизатор: 'амортизатор', датчик: 'датчик', лампа: 'лампа', щитка: 'щетка', щетка: 'щетка', сайлентблок: 'сайлентблок',
  водянии: 'водяной', водяний: 'водяной', водяной: 'водяной', паливнии: 'топливний', паливний: 'топливний', топливнии: 'топливний',
  повитрянии: 'воздушний', повитряний: 'воздушний', воздушнии: 'воздушний', масляний: 'масляний', маслянии: 'масляний',
  рульова: 'рулевая', рульовии: 'рулевая', рульови: 'рулевая', рульове: 'рулевая', рулевая: 'рулевая', рулевои: 'рулевая',
  салону: 'салона', салона: 'салона', передня: 'передняя', передний: 'передний', задня: 'задняя', задний: 'задний',
}

/** Основа слова: перші 5 літер — «тормозные»/«тормоз», «воздушный»/«воздушная» зводяться до одного. */
const canon = (word: string) => { const folded = foldWord(word); return (TYPE_SYNONYMS[folded] ?? folded).slice(0, 5) }
/** Слова назви, що описують тип товару: лише літерні, від 3 знаків, у спільній «абетці». */
export function typeWords(name: string): string[] {
  return String(name ?? '').split(/[\s,.;:()«»"/\\+-]+/).filter(word => /^\p{L}{3,}$/u.test(word)).map(canon).filter(word => word.length >= 3)
}

export interface CategoryModel { byTwo: Map<string, Map<string, number>>; byOne: Map<string, Map<string, number>> }

/** Навчити модель на наших картках із категорією. */
export function learnCategories(products: Array<{ name: string; category_id: string | null }>): CategoryModel {
  const model: CategoryModel = { byTwo: new Map(), byOne: new Map() }
  const add = (map: Map<string, Map<string, number>>, key: string, category: string) => {
    if (!key) return
    const counts = map.get(key) ?? new Map<string, number>()
    counts.set(category, (counts.get(category) ?? 0) + 1); map.set(key, counts)
  }
  for (const product of products) {
    if (!product.category_id) continue
    const words = typeWords(product.name)
    if (words.length >= 2) add(model.byTwo, words[0] + ' ' + words[1], product.category_id)
    if (words.length >= 1) add(model.byOne, words[0], product.category_id)
  }
  return model
}

function best(counts: Map<string, number> | undefined, minTotal: number, minShare: number): string | null {
  if (!counts) return null
  let total = 0, top = '', topCount = 0
  for (const [category, count] of counts) { total += count; if (count > topCount) { top = category; topCount = count } }
  return total >= minTotal && topCount / total >= minShare ? top : null
}

/** Категорія для назви товару постачальника або null (невпевнено — лишаємо без категорії). */
export function guessCategory(model: CategoryModel, name: string): string | null {
  const words = typeWords(name)
  if (!words.length) return null
  if (words.length >= 2) {
    const exact = best(model.byTwo.get(words[0] + ' ' + words[1]), 2, 0.6)
    if (exact) return exact
  }
  // Одне слово («Накладка», «Комплект») — слабша ознака: беремо лише коли картки з ним майже завжди в одній категорії.
  return best(model.byOne.get(words[0]), 5, 0.8)
}
