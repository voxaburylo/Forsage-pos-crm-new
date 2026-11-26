/**
 * ШІ-помічник розділу «Сайт»: типи пропозицій і запис підтвердженого на сайт.
 * Записуємо тим самим шлюзом, що й решта розділу (журнал аудиту веде сервер). З 27.11.2026 («Доповнення 5» контракту
 * сайту): тексти товарів — пачкою через seo.products.set (сайт змінює лише надіслані поля), розділи каталогу —
 * seo.categories.set, форум — теми й відповіді від імені магазину.
 */
export interface SeoProductText { product_id: string; name: string; sku: string | null; description?: string; seo_title?: string; seo_description?: string; seo_keywords?: string; notes: string[] }
export interface SeoSection { id: string; name: string; seo_title?: string; seo_description?: string; description?: string; faq?: Array<{ q: string; a: string }>; notes: string[] }
export type SeoAction =
  | { id: string; kind: 'product_texts'; title: string; items: SeoProductText[]; refused: Array<{ product_id: string; reason: string }> }
  | { id: string; kind: 'article'; title: string; page_id: string | null; content: string; words: number }
  | { id: string; kind: 'site_seo'; title: string; seo_title: string; seo_description: string }
  | { id: string; kind: 'forum_post'; title: string; post_kind: 'topic' | 'reply'; section: string; topic_id: string | null; topic_title: string; body: string }
  | { id: string; kind: 'section_seo'; title: string; items: SeoSection[]; refused: Array<{ id: string; reason: string }> }

export interface SeoEntry { role: 'user' | 'model'; text: string; actions?: SeoAction[] }
export type SeoCall = <T = unknown>(action: string, params?: Record<string, unknown>) => Promise<T>
export interface SeoApplyResult { done: number; failed: Array<{ item: string; error: string }> }

const message = (reason: unknown) => reason instanceof Error && reason.message ? reason.message : 'сайт не прийняв'
const given = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ''))

/** Тексти товарів однією пачкою: сайт змінює лише надіслані поля, решта товару лишається як була. */
export async function applyProductTexts(items: readonly SeoProductText[], call: SeoCall): Promise<SeoApplyResult> {
  if (!items.length) return { done: 0, failed: [] }
  try {
    const answer = (await call<{ saved?: number; not_on_site?: unknown[] }>('seo.products.set', {
      items: items.map(item => ({ program_product_id: item.product_id, ...given({ seo_title: item.seo_title, seo_description: item.seo_description, seo_keywords: item.seo_keywords, description: item.description }) })),
    })) ?? {}
    const missing = new Set((Array.isArray(answer.not_on_site) ? answer.not_on_site : []).map(String))
    const failed = items.filter(item => missing.has(item.product_id)).map(item => ({ item: item.name, error: 'цього товару немає на сайті' }))
    return { done: items.length - failed.length, failed }
  } catch (reason) { return { done: 0, failed: items.map(item => ({ item: item.name, error: message(reason) })) } }
}

/** Розділи каталогу: по одному запиту на розділ; збій одного не зупиняє решту. */
export async function applySectionSeo(items: readonly SeoSection[], call: SeoCall, onProgress?: (done: number) => void): Promise<SeoApplyResult> {
  const result: SeoApplyResult = { done: 0, failed: [] }
  for (const item of items) {
    try {
      await call('seo.categories.set', { id: item.id, ...given({ seo_title: item.seo_title, seo_description: item.seo_description, description: item.description }), ...(item.faq?.length ? { faq: item.faq } : {}) })
      result.done += 1
    } catch (reason) { result.failed.push({ item: item.name, error: message(reason) }) }
    onProgress?.(result.done + result.failed.length)
  }
  return result
}

/** Тема чи відповідь на форумі від імені магазину. Повертає адресу теми, якщо сайт її дав. */
export async function applyForumPost(action: Extract<SeoAction, { kind: 'forum_post' }>, call: SeoCall): Promise<string> {
  if (action.post_kind === 'topic') {
    const created = await call<{ url?: string } | null>('forum.topics.create', { section: action.section, title: action.topic_title, body: action.body })
    return String(created?.url ?? '')
  }
  if (!action.topic_id) throw new Error('Не вказано тему для відповіді')
  await call('forum.posts.create', { topic_id: action.topic_id, body: action.body })
  return ''
}

export async function applyArticle(action: Extract<SeoAction, { kind: 'article' }>, call: SeoCall): Promise<void> {
  const title = action.title.replace(/^Стаття:\s*/, '')
  if (!action.page_id) { await call('pages.upsert', { type: 'article', title, content: action.content, image_url: null }); return }
  const rows = await call<Array<Record<string, unknown>>>('pages.list')
  const row = (Array.isArray(rows) ? rows : []).find(item => String(item.id) === action.page_id)
  if (!row) throw new Error('Статті, яку треба оновити, на сайті вже немає')
  await call('pages.upsert', { id: row.id, type: row.type ?? 'article', title, content: action.content, image_url: row.image_url ?? null })
}

export async function applySiteSeo(action: Extract<SeoAction, { kind: 'site_seo' }>, keys: readonly string[], call: SeoCall): Promise<void> {
  const current = (await call<Record<string, unknown>>('settings.get')) ?? {}
  const values = Object.fromEntries(keys.map(key => [key, current[key] == null ? '' : String(current[key])]))
  if (action.seo_title) values.seo_title = action.seo_title
  if (action.seo_description) values.seo_description = action.seo_description
  await call('settings.set', { values })
}

/** Історія для сервера: лише тексти, останні 30 реплік, починаючи з репліки власника. */
export function seoHistory(entries: readonly SeoEntry[], outcome: Readonly<Record<string, string | undefined>>): Array<{ role: 'user' | 'model'; text: string }> {
  const turns = entries.filter(entry => entry.text.trim()).map(entry => {
    const notes = (entry.actions ?? []).map(action => `«${action.title}»: ${outcome[action.id] ?? 'власник ще не підтвердив'}`)
    return { role: entry.role, text: (entry.text + (notes.length ? `\n\n[Підсумок програми для помічника, власник цього не бачить: ${notes.join('; ')}]` : '')).slice(0, 30_000) }
  }).slice(-30)
  const first = turns.findIndex(turn => turn.role === 'user')
  return first < 0 ? [] : turns.slice(first)
}

/** Готові завдання одним натиском — щоб власнику не вигадувати, як просити. */
export const SEO_QUICK: ReadonlyArray<{ label: string; text: string }> = [
  { label: 'План просування', text: 'Подивись стан просування сайту (seo_health), головну, каталог, статті й форум і дай план на найближчий місяць: 5 кроків за пріоритетом. Почни з першого кроку.' },
  { label: 'Заголовки й описи всім товарам', text: 'Зроби заголовок, опис і ключові слова для Google усім товарам сайту, де їх немає; де немає тексту опису — напиши і його.' },
  { label: 'Розділи каталогу', text: 'Подивись розділи каталогу сайту і для тих, де немає тексту, підготуй заголовок, опис, текст розділу і 3–5 питань-відповідей. Почни з найбільших розділів.' },
  { label: 'Розклади по категоріях', text: 'Розклади по наших категоріях товари постачальників, які прийшли по API без категорії.' },
  { label: 'Теми для форуму', text: 'Подивись наш форум і запропонуй 5 нових корисних тем від магазину під запити з Google, яких там ще немає. Першу напиши повністю.' },
  { label: 'Стаття під запит', text: 'Запропонуй 5 тем статей, які шукають наші покупці в Google і яких ще немає на сайті, і напиши першу.' },
]
