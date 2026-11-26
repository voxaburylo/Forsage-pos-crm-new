/**
 * Команда «створити категорію» від сервера (27.11.2026, слово власника: «якщо в нас такої категорії немає, то він її
 * створює»). Нові категорії під товари постачальників пропонує помічник сайту; створює їх каса — категорії є її даними,
 * і вона сама передасть нову категорію в хмару. Каса перевіряє назву ще раз і не створює дубля: категорія з такою назвою
 * вже є (регістр і зайві пробіли не рахуються) — повертається вона.
 */
export interface TillCategory { id: string; name: string }
const norm = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('uk-UA')

export function tillCategoryToCreate(payload: unknown, existing: readonly TillCategory[]): { name: string; existing: TillCategory | null } {
  const name = String((payload as { name?: unknown })?.name ?? '').replace(/\s+/g, ' ').trim()
  if (name.length < 3 || name.length > 60) throw new Error('Назва категорії має бути від 3 до 60 знаків')
  // Латиниця й цифри — ознака бренду, моделі чи розміру: таку категорію помічник створювати не має.
  if (!/^[А-ЯІЇЄҐа-яіїєґʼ’ ,-]+$/u.test(name)) throw new Error('Назва категорії має бути українською, без цифр і латиниці')
  return { name, existing: existing.find(category => norm(category.name) === norm(name)) ?? null }
}
