import { PhotoAiLater, PhotoAiStop, STOP_TEXT, squash, type PhotoProduct } from './photoSearch.js'

/**
 * «Пошук фото з ШІ», крок 2 — перевірка: чи на фото саме цей товар. Модель Gemini, температура 0, відповідь — лише JSON.
 * Рішення «підходить / ні» ухвалює програма за відповіддю (decidePhoto), а не сама модель: правила однакові для всіх.
 */
export const GEMINI_MODEL = process.env.PHOTO_AI_GEMINI_MODEL || 'gemini-2.5-flash'
export const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/'

export interface PhotoVerdict {
  match: boolean; details_match: boolean; title_brand: string; brand_on_photo: string; brand_same: boolean
  white_background: boolean; no_extra_text: boolean; good_quality: boolean
}
export interface PhotoRules { require_white: boolean; forbid_text: boolean }

export function verdictPrompt(product: PhotoProduct): string {
  return `Назва товару в автомагазині: «${product.name}». Бренд: ${product.brand?.trim() || '—'}. Артикул: ${product.sku?.trim() || '—'}. `
    + 'Оціни фото для картки САМЕ ЦЬОГО товару. Будь суворим: краще відхилити сумнівне фото, ніж показати покупцю чужий товар. Поверни JSON: '
    + 'match (той самий тип товару; логотип, схема, авто, людина, набір різних товарів — false), '
    + 'details_match (видимі характеристики не суперечать назві: призначення, розмір, діаметр, обʼєм, вʼязкість, кількість у наборі, колір; будь-яка розбіжність — false), '
    + 'title_brand (бренд з назви або ""), brand_on_photo (бренд, видимий на товарі/упаковці, або ""), '
    + 'brand_same (true лише якщо бренду в назві немає або на фото той самий бренд, з урахуванням транслітерації Гетьман = Hetman), '
    + 'white_background (білий фон без інтерʼєру, столу, руки), '
    + 'no_extra_text (немає водяних знаків, цін, назв магазинів, сайтів, рамок, колажів; текст на самій упаковці — можна), '
    + 'good_quality (чітке, товар видно повністю і займає більшу частину кадру).'
}

const VERDICT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    match: { type: 'BOOLEAN' }, details_match: { type: 'BOOLEAN' }, title_brand: { type: 'STRING' }, brand_on_photo: { type: 'STRING' },
    brand_same: { type: 'BOOLEAN' }, white_background: { type: 'BOOLEAN' }, no_extra_text: { type: 'BOOLEAN' }, good_quality: { type: 'BOOLEAN' },
  },
  required: ['match', 'details_match', 'title_brand', 'brand_on_photo', 'brand_same', 'white_background', 'no_extra_text', 'good_quality'],
}

/** Відповідь моделі → вердикт. Усе, чого бракує або що не true, вважаємо «ні»: сумнів — на користь відмови. */
export function parseVerdict(text: string): PhotoVerdict | null {
  const block = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!block) return null
  let raw: Record<string, unknown>
  try { raw = JSON.parse(block) as Record<string, unknown> } catch { return null }
  if (!raw || typeof raw !== 'object') return null
  const yes = (key: string) => raw[key] === true
  const word = (key: string) => typeof raw[key] === 'string' ? (raw[key] as string).trim().slice(0, 80) : ''
  return {
    match: yes('match'), details_match: yes('details_match'), title_brand: word('title_brand'), brand_on_photo: word('brand_on_photo'),
    brand_same: yes('brand_same'), white_background: yes('white_background'), no_extra_text: yes('no_extra_text'), good_quality: yes('good_quality'),
  }
}

const alphabet = (value: string) => /[а-яіїєґё]/i.test(value) ? 'cyr' : /[a-z]/i.test(value) ? 'lat' : 'none'
export function sameBrand(a: string, b: string): boolean {
  const left = squash(a), right = squash(b)
  if (!left || !right) return false
  return left === right || (Math.min(left.length, right.length) >= 3 && (left.includes(right) || right.includes(left)))
}

/**
 * Чи підходить фото. Обовʼязково: той самий товар, характеристики не суперечать, якість.
 * Бренд: інший бренд тим самим алфавітом на фото — відмова; різні алфавіти (Гетьман / Hetman) — вірить моделі;
 * бренду на фото не видно — він має бути в заголовку чи адресі картинки. Білий фон і «без написів» — якщо ввімкнено.
 */
export function decidePhoto(verdict: PhotoVerdict, rules: PhotoRules, product: PhotoProduct, sourceText: string): { ok: boolean; reason: string } {
  const no = (reason: string) => ({ ok: false, reason })
  if (!verdict.match) return no('на фото інший товар')
  if (!verdict.details_match) return no('характеристики на фото не збігаються з назвою')
  if (!verdict.good_quality) return no('нечітке фото або товар видно не повністю')
  const brand = (product.brand ?? '').trim() || verdict.title_brand
  if (brand) {
    const seen = verdict.brand_on_photo
    if (seen) {
      if (!sameBrand(brand, seen) && (alphabet(brand) === alphabet(seen) || !verdict.brand_same)) return no('на фото інший бренд: ' + seen)
    } else if (!squash(sourceText).includes(squash(brand))) return no('бренду не видно ні на фото, ні в описі картинки')
  }
  if (rules.require_white && !verdict.white_background) return no('фон не білий')
  if (rules.forbid_text && !verdict.no_extra_text) return no('є водяний знак, ціна або напис магазину')
  return { ok: true, reason: 'підходить' }
}

export interface GeminiDeps { fetch?: typeof fetch }

/** Один платний запит до Gemini. 429/503 — «спробувати пізніше» (чергу не роняємо); поганий ключ — зупинка з поясненням. */
export async function geminiVerdict(apiKey: string, image: { mime: string; base64: string }, prompt: string, deps: GeminiDeps = {}, signal?: AbortSignal): Promise<PhotoVerdict | null> {
  const ask = (thinkingOff: boolean) => (deps.fetch ?? fetch)(GEMINI_URL + encodeURIComponent(GEMINI_MODEL) + ':generateContent', {
    method: 'POST', headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: image.mime, data: image.base64 } }, { text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: VERDICT_SCHEMA, ...(thinkingOff ? { thinkingConfig: { thinkingBudget: 0 } } : {}) },
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000),
  })
  let response: Response, text: string
  try {
    // «Роздуми» вимкнено: дешевше й швидше. Якщо модель цього параметра не приймає — той самий запит без нього.
    response = await ask(true)
    text = await response.text().catch(() => '')
    if (response.status === 400 && /thinking/i.test(text)) { response = await ask(false); text = await response.text().catch(() => '') }
  } catch { throw new PhotoAiLater('Gemini не відповів') }
  if (!response.ok) {
    if (response.status === 429 || response.status === 503 || response.status === 500) throw new PhotoAiLater('Gemini зайнятий (код ' + response.status + ')')
    if (response.status === 401 || response.status === 403 || /API[_ ]key/i.test(text)) throw new PhotoAiStop('gemini_key', STOP_TEXT.gemini_key)
    if (response.status === 404) throw new PhotoAiStop('gemini_model', STOP_TEXT.gemini_model)
    // 400 на одну картинку (наприклад, модель не змогла її прочитати) — це відмова для цієї картинки, а не для черги.
    return null
  }
  try {
    const parsed = JSON.parse(text) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    const answer = (parsed.candidates?.[0]?.content?.parts ?? []).map(part => part.text ?? '').join('')
    return parseVerdict(answer)
  } catch { return null }
}
