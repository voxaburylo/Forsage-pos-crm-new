/**
 * Правила «наведення порядку» в каталозі, узгоджені з власником 15.11.2026.
 * Тут лише чисті функції: що саме змінити. Запис виконує `CatalogTidyRepository`
 * через звичайне збереження картки, тому зміни потрапляють і на сервер.
 */

/** Ціни в копійках. До 10 грн — до цілої гривні, далі — до 5 грн. Лише вгору: ціна не падає нижче закупівлі. */
export function roundRetailUp(kopecks: number): number {
  if (!Number.isSafeInteger(kopecks) || kopecks <= 0) return kopecks
  return kopecks < 1000 ? Math.ceil(kopecks / 100) * 100 : Math.ceil(kopecks / 500) * 500
}

/**
 * «Втрачені тисячі»: 1,09 грн при закупівлі 905 грн — ціну, схоже, ввели в тисячах.
 * Власник вирішив не виправляти їх автоматично, тому округлення такі картки пропускає.
 */
export function looksLikeLostThousands(retail: number, purchase: number): boolean {
  return retail > 0 && retail < 1000 && purchase >= 10000
}

export function needsRounding(retail: number, purchase: number): boolean {
  return retail > 0 && retail % 100 !== 0 && !looksLikeLostThousands(retail, purchase)
}

/** Подвійні пробіли, табуляції, переноси рядків і пробіли по краях. Більше нічого в назві не змінюється. */
export function tidyName(name: string): string {
  return String(name ?? '').replace(/\s+/gu, ' ').trim()
}

/** Сміттєва назва: «1», лише цифри чи знаки, або код одним словом замість назви. */
export function isGarbageName(name: string): boolean {
  const clean = tidyName(name)
  return clean.length < 4 || !/\p{L}/u.test(clean) || /^[A-Za-z0-9._/-]+$/.test(clean)
}

const WORD_ALIASES: Record<string, string> = {
  фильтр: 'фільтр', масло: 'олива', мастило: 'олива', подшипник: 'підшипник', лампа: 'лампа',
  ремень: 'ремінь', свеча: 'свічка', свечи: 'свічка', щетка: 'щітка', жидкость: 'рідина',
  // Той самий товар у каталозі записано і російською, і українською.
  масляный: 'масляний', маслянный: 'масляний', воздушный: 'повітряний', топливный: 'паливний', салона: 'салону',
  тормозной: 'гальмівний', тормозная: 'гальмівний', тормозные: 'гальмівний', зажигания: 'запалювання',
  рулевой: 'рульовий', рулевая: 'рульовий', передний: 'передній', задний: 'задній', радиатора: 'радіатора',
}
/** Перші змістовні слова назви: «Фільтр масляний WIX…» → «фільтр масляний». */
export function nameKey(name: string, words: number): string {
  const tokens = tidyName(name).toLocaleLowerCase('uk').replace(/ё/g, 'е').match(/\p{L}{3,}/gu) ?? []
  return tokens.length < words ? '' : tokens.slice(0, words).map(token => WORD_ALIASES[token] ?? token).join(' ')
}

export interface CategorySample { name: string; category_id: string | null }
export interface CategoryRule { category_id: string; share: number; samples: number }
export const CATEGORY_MIN_SAMPLES = 8
export const CATEGORY_MIN_SHARE = 0.85

/**
 * Правило вчиться на товарах, які власник уже розклав сам: якщо серед товарів з таким
 * початком назви не менше 85 % лежать в одній категорії (і прикладів не менше 8), туди
 * піде й товар без категорії. Нові категорії не створюються, розкладені товари не переносяться.
 */
export function learnCategoryRules(categorized: readonly CategorySample[]): (name: string) => CategoryRule | null {
  const build = (words: number) => {
    const counts = new Map<string, Map<string, number>>()
    for (const item of categorized) {
      if (!item.category_id) continue
      const key = nameKey(item.name, words)
      if (!key) continue
      const bucket = counts.get(key) ?? new Map<string, number>()
      bucket.set(item.category_id, (bucket.get(item.category_id) ?? 0) + 1)
      counts.set(key, bucket)
    }
    return (name: string): CategoryRule | null => {
      const bucket = counts.get(nameKey(name, words))
      if (!bucket) return null
      let total = 0, best = '', bestCount = 0
      // Порядок ключів стабільний: за кількістю, далі за ідентифікатором.
      for (const [category, count] of [...bucket.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
        total += count
        if (count > bestCount) { best = category; bestCount = count }
      }
      return total >= CATEGORY_MIN_SAMPLES && bestCount / total >= CATEGORY_MIN_SHARE ? { category_id: best, share: bestCount / total, samples: total } : null
    }
  }
  const byTwo = build(2), byOne = build(1)
  return name => byTwo(name) ?? byOne(name)
}

/** Назви категорій, що відрізняються лише регістром і пробілами: «Авто-Компрессор» / «Авто-компрессор». */
export function categoryNameKey(name: string): string {
  return tidyName(name).toLocaleLowerCase('uk').replace(/ё/g, 'е')
}
