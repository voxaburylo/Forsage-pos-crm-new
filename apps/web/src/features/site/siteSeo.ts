/**
 * ШІ-помічник розділу «Сайт» (26.11.2026): типи пропозицій і запис підтвердженого на сайт.
 * Записуємо тим самим шлюзом, що й решта розділу (журнал аудиту веде сервер). Поле, якого помічник не чіпав, лишається
 * на сайті як було: перед записом читаємо поточні значення й зливаємо. Не прочитали — не пишемо (щоб не стерти чуже).
 */
export interface SeoProductText { product_id: string; name: string; sku: string | null; description?: string; seo_title?: string; seo_description?: string; notes: string[] }
export type SeoAction =
  | { id: string; kind: 'product_texts'; title: string; items: SeoProductText[]; refused: Array<{ product_id: string; reason: string }> }
  | { id: string; kind: 'article'; title: string; page_id: string | null; content: string; words: number }
  | { id: string; kind: 'site_seo'; title: string; seo_title: string; seo_description: string }
  | { id: string; kind: 'forum_post'; title: string; post_kind: 'topic' | 'reply'; section: string; body: string }

export interface SeoEntry { role: 'user' | 'model'; text: string; actions?: SeoAction[] }
export type SeoCall = <T = unknown>(action: string, params?: Record<string, unknown>) => Promise<T>
export interface SeoApplyResult { done: number; failed: Array<{ item: string; error: string }> }

const message = (reason: unknown) => reason instanceof Error && reason.message ? reason.message : 'сайт не прийняв'

export async function applyProductTexts(items: readonly SeoProductText[], call: SeoCall, onProgress?: (done: number) => void): Promise<SeoApplyResult> {
  const result: SeoApplyResult = { done: 0, failed: [] }
  for (const item of items) {
    try {
      const current = (await call<Record<string, unknown> | null>('products.site_fields.get', { program_product_id: item.product_id })) ?? {}
      await call('products.site_fields.set', {
        program_product_id: item.product_id,
        description: item.description ?? String(current.description ?? ''),
        specs: current.specs && typeof current.specs === 'object' ? current.specs : {},
        hidden: Boolean(current.hidden),
        seo_title: item.seo_title ?? String(current.seo_title ?? ''),
        seo_description: item.seo_description ?? String(current.seo_description ?? ''),
      })
      result.done += 1
    } catch (reason) { result.failed.push({ item: item.name, error: message(reason) }) }
    onProgress?.(result.done + result.failed.length)
  }
  return result
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
    const notes = (entry.actions ?? []).map(action => `«${action.title}»: ${outcome[action.id] ?? (action.kind === 'forum_post' ? 'текст показано власнику' : 'власник ще не підтвердив')}`)
    return { role: entry.role, text: (entry.text + (notes.length ? `\n\n[Підсумок програми для помічника, власник цього не бачить: ${notes.join('; ')}]` : '')).slice(0, 30_000) }
  }).slice(-30)
  const first = turns.findIndex(turn => turn.role === 'user')
  return first < 0 ? [] : turns.slice(first)
}

/** Готові завдання одним натиском — щоб власнику не вигадувати, як просити. */
export const SEO_QUICK: ReadonlyArray<{ label: string; text: string }> = [
  { label: 'План просування', text: 'Подивись наш сайт (головну, каталог, статті, форум) і дай план просування в Google на найближчий місяць: 5 кроків за пріоритетом. Почни з першого кроку.' },
  { label: 'Описи всім товарам', text: 'Зроби тексти для сторінок усіх товарів у наявності: опис, заголовок і опис для пошуковика.' },
  { label: 'Розклади по категоріях', text: 'Розклади по наших категоріях товари постачальників, які прийшли по API без категорії.' },
  { label: 'Стаття під запит', text: 'Запропонуй 5 тем статей, які шукають наші покупці в Google і яких ще немає на сайті, і напиши першу.' },
  { label: 'Теми для форуму', text: 'Подивись наш форум і запропонуй 5 нових тем під запити з Google, яких там ще немає. Першу напиши повністю.' },
  { label: 'Перевір головну', text: 'Перевір головну сторінку сайту очима Google: заголовок, опис, заголовки на сторінці, текст. Що виправити? Якщо треба — запропонуй новий заголовок і опис.' },
]
