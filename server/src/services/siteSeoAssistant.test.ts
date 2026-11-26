import { describe, expect, it, vi } from 'vitest'
import { handleSeoTool, type SeoAction, type SeoDeps } from './siteSeoAssistant.js'
import { checkProductTexts, pageDigest, sitePath } from './siteSeoText.js'
import { SITE_SEO_PROMPT, SITE_SEO_TOOLS } from './siteSeoPrompt.js'

// 26.11.2026, власник: «той самий помічник, але в розділі „Сайт“ відповідає за SEO, описи товарів і форум».
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const names = new Map([[id(1), { name: 'Олива Castrol Magnatec 5W-40 4л s', sku: '15C9D0' as string | null }], [id(2), { name: 'Свічка NGK BKR6E', sku: null }]])
const FORUM_HTML = '<html><head><title>Форум &amp; поради | Форсаж</title><meta name="description" content="Поради про шини"><style>.a{}</style></head>'
  + '<body><h1>Форум</h1><h2>Шини</h2><script>evil()</script><a href="/forum/12-shypy">Шипи чи липучка</a><p>Текст  теми</p></body></html>'
function deps(over: Partial<SeoDeps> = {}): SeoDeps {
  return {
    gateway: vi.fn(async (action: string) => action === 'products.site_fields.get' ? { description: 'Старий опис', seo_title: '', hidden: false, photos: [{}, {}] }
      : action === 'pages.list' ? [{ id: 7, type: 'article', title: 'Як вибрати акумулятор', content: 'x'.repeat(900) }] : { seo_title: 'Форсаж', seo_description: 'Магазин', contact_phone1: '+380' }),
    listProducts: vi.fn(async () => ({ total: 1, pages: 1, rows: [{ id: id(1), sku: '15C9D0', name: 'Олива Castrol', brand: 'Castrol', category: 'Оливи', qty: '3.000', photo: 'u', hidden: false, purchase: 99900 }] })),
    listCategories: vi.fn(async () => [{ id: 'c1', parent_id: null, name: 'Оливи' }]),
    productNames: vi.fn(async (ids: string[]) => new Map(ids.filter(key => names.has(key)).map(key => [key, names.get(key)!]))),
    fetchPage: vi.fn(async () => FORUM_HTML),
    startTextJob: vi.fn(async () => ({ total: 6485 })),
    startCategorySort: vi.fn(async () => ({ waiting: 62937 })),
    ...over,
  }
}
const run = (name: string, args: Record<string, any>, d = deps(), actions: SeoAction[] = []) =>
  handleSeoTool(name, args, d, actions, async () => ({ text: 'запити' })).then(result => ({ result: result as any, actions, d }))

describe('site SEO assistant: reads the shop and the site, only proposes', () => {
  it('lists products without purchase prices and reads what the site shows now', async () => {
    const list = await run('list_products', { in_stock: true })
    expect(list.d.listProducts).toHaveBeenCalledWith({ q: '', category: '', flag: 'in_stock', page: 1 })
    expect(list.result.products[0]).toEqual({ product_id: id(1), sku: '15C9D0', name: 'Олива Castrol', brand: 'Castrol', category: 'Оливи', qty: 3, has_photo: true, hidden: false })
    expect(JSON.stringify(list.result)).not.toContain('99900')
    const texts = await run('get_product_site_texts', { product_ids: [id(1), id(9)] })
    expect(texts.result.products[0]).toMatchObject({ product_id: id(1), description: 'Старий опис', photos: 2 })
    expect(texts.result.products[1]).toEqual({ product_id: id(9), error: 'товару немає' })
  })

  it('product texts become one proposal; a price, purchase words or an unknown id are refused; long titles are flagged', async () => {
    const { result, actions } = await run('propose_product_texts', { items: [
      { product_id: id(1), description: 'Синтетична моторна олива Castrol Magnatec 5W-40 для бензинових і дизельних двигунів легкових авто. Каністра 4 літри, артикул 15C9D0.',
        seo_title: 'Олива Castrol Magnatec 5W-40 4л 15C9D0 — купити моторну оливу для бензинових і дизельних двигунів', seo_description: 'Моторна олива Castrol Magnatec 5W-40.' },
      { product_id: id(2), description: 'Свічка запалювання NGK за 120 грн — найкраща ціна в місті, встигніть купити вже сьогодні зі знижкою для всіх.' },
      { product_id: id(9), description: 'x'.repeat(200) },
    ] })
    expect(result).toMatchObject({ status: 'pending_user_confirmation', accepted: 1, long: 1 })
    expect(actions).toHaveLength(1)
    const action = actions[0] as Extract<SeoAction, { kind: 'product_texts' }>
    expect(action.items[0]).toMatchObject({ product_id: id(1), name: 'Олива Castrol Magnatec 5W-40 4л s', sku: '15C9D0' })
    expect(action.items[0].notes[0]).toMatch(/Google обріже/)
    expect(action.refused.map(row => row.reason)).toEqual(['у тексті є ціна — вона застаріє, сайт показує ціну сам', 'товару з таким id немає'])
    expect(checkProductTexts([{ product_id: id(2), seo_title: 'Закупівельна ціна нижча' }], new Set([id(2)])).refused[0].reason).toMatch(/закупівлю/)
  })

  it('article, home page SEO and a forum draft are proposals too; the forum one says the program cannot post', async () => {
    const actions: SeoAction[] = []
    expect((await run('propose_article', { title: 'Коротко', content: 'мало' }, deps(), actions)).result.error).toMatch(/коротка/)
    await run('propose_article', { title: 'Шипи чи липучка: що брати на зиму', content: 'Абзац про вибір шин. '.repeat(40) }, deps(), actions)
    await run('propose_site_seo', { seo_title: 'Форсаж — шини й автозапчастини' }, deps(), actions)
    expect(actions.map(action => action.kind)).toEqual(['article', 'site_seo'])
  })

  // 27.11.2026, «Доповнення 5» контракту сайту: програма публікує на форумі від імені магазину.
  it('forum: a topic needs a real section and honest text; a reply needs an open topic; fake customer voices are refused', async () => {
    const forum = (over: Record<string, unknown> = {}) => deps({ gateway: vi.fn(async (action: string) => action === 'forum.sections.list' ? [{ id: 3, slug: 'khodova', name: 'Ходова' }]
      : action === 'forum.topic.get' ? { title: 'Шипи чи липучка', is_locked: false, body: 'Питання', posts: [], ...over } : {}) })
    const body = 'Биття керма на швидкості найчастіше дає дисбаланс коліс. Почніть із балансування: це найдешевша перевірка. '.repeat(4)
    const actions: SeoAction[] = []
    expect((await run('propose_forum_post', { kind: 'topic', section: 'nema', title: 'Биття керма на 100 км/год: що перевірити', body }, forum(), actions)).result.error).toMatch(/розділу форуму немає/)
    expect((await run('propose_forum_post', { kind: 'topic', section: 'khodova', title: 'Биття керма на 100 км/год: що перевірити', body }, forum(), actions)).result.status).toBe('pending_user_confirmation')
    expect((await run('propose_forum_post', { kind: 'reply', topic_id: '12', body: 'Для наших зим липучка зазвичай зручніша в місті. s' }, forum(), actions)).result.status).toBe('pending_user_confirmation')
    expect(actions).toMatchObject([{ kind: 'forum_post', post_kind: 'topic', section: 'khodova', topic_id: null }, { kind: 'forum_post', post_kind: 'reply', topic_id: '12', topic_title: 'Шипи чи липучка' }])
    expect((await run('propose_forum_post', { kind: 'reply', topic_id: '12', body: 'Тема закрита, але відповім все одно.' }, forum({ is_locked: true }))).result.error).toMatch(/закрита/)
    expect((await run('propose_forum_post', { kind: 'topic', section: 'khodova', title: 'Відгук про шини Rosava', body: body + ' Наш клієнт розповів, що проїхав три зими.' }, forum())).result.error).toMatch(/вигаданий відгук/)
    expect((await run('propose_forum_post', { kind: 'topic', section: 'khodova', title: 'Скільки коштує балансування', body: body + ' У нас це 150 грн.' }, forum())).result.error).toMatch(/ціна/)
  })

  it('catalogue sections: title, description, text and 3–5 questions; unknown sections and prices are refused', async () => {
    const sections = deps({ gateway: vi.fn(async () => [{ id: 5, name: 'Моторні оливи', url: '/katalog/masla', description: '', faq: [] }]) })
    const faq = [{ q: 'Яку вʼязкість вибрати?', a: 'Ту, яку вказав виробник авто в сервісній книжці.' }, { q: 'Чи можна змішувати оливи?', a: 'Краще не змішувати оливи різних типів.' }, { q: 'Як часто міняти оливу?', a: 'За регламентом виробника вашого авто.' }]
    const { result, actions } = await run('propose_section_seo', { items: [
      { id: 5, seo_title: 'Моторні оливи — купити в Синельниковому | Форсаж', seo_description: 'Моторні оливи для бензинових і дизельних двигунів: синтетика й напівсинтетика. Підберемо за допуском вашого авто, доставка по Україні.', faq },
      { id: 9, seo_title: 'Немає такого розділу' }, { id: 5, seo_title: 'двічі' },
    ] }, sections)
    expect(result).toMatchObject({ status: 'pending_user_confirmation', accepted: 1 })
    const action = actions[0] as Extract<SeoAction, { kind: 'section_seo' }>
    expect(action.items[0]).toMatchObject({ id: '5', name: 'Моторні оливи', faq })
    expect(action.refused).toEqual([{ id: '9', reason: 'розділу з таким id немає' }])
    expect((await run('propose_section_seo', { items: [{ id: 5, description: 'Оливи від 300 грн за літр.' }] }, sections)).result.error).toBeTruthy()
  })

  it('reads only our site, as Google sees it: title, description, headings, links; scripts and styles are dropped', async () => {
    const page = await run('fetch_site_page', { path: '/forum' })
    expect(page.result).toMatchObject({ url: 'https://www.forsage-tires.com/forum', title: 'Форум & поради | Форсаж', description: 'Поради про шини', h1: ['Форум'], headings: ['Шини'], links: ['/forum/12-shypy'] })
    expect(page.result.text).toBe('Форум Шини Шипи чи липучка Текст теми')
    for (const path of ['https://evil.example/x', '//evil.example', '/admin/users', '/a/../admin', 'forum', '/a b']) {
      const refused = await run('fetch_site_page', { path })
      expect(refused.result.error).toBeTruthy()
      expect(refused.d.fetchPage).not.toHaveBeenCalled()
    }
    expect(sitePath('/forum?c=shyny-zymovi')).toBe('/forum?c=shyny-zymovi')
    expect(pageDigest('<urlset><url><loc>https://www.forsage-tires.com/p/1-s</loc></url></urlset>').links).toEqual(['/p/1-s'])
  })

  it('the settings are honest: no invented reviews or phones, nothing is promised; every declared tool has a handler', async () => {
    expect(SITE_SEO_PROMPT).toMatch(/вигадані відгуки/)
    expect(SITE_SEO_PROMPT).toMatch(/телефони бери ЛИШЕ з get_shop_contacts/)
    expect(SITE_SEO_PROMPT).toMatch(/Обіцяти «перше місце в Google»/)
    for (const tool of SITE_SEO_TOOLS) expect((await run(tool.name, {})).result).not.toEqual({ error: 'Невідомий інструмент' })
    expect(checkProductTexts([{ product_id: id(1) }], new Set([id(1)])).refused[0].reason).toBe('порожня пропозиція')
  })
})

// 26.11.2026 (перевірка наживо): «в наявності» мовчки відкидало «з фото» — помічник отримував товари без фото.
describe('product filter: both wishes together', () => {
  it('keeps both, and each one alone', async () => {
    const { productFlag } = await import('./siteSeoAssistant.js')
    expect(productFlag(true, true)).toBe('in_stock_photo')
    expect(productFlag(true, false)).toBe('in_stock')
    expect(productFlag(false, true)).toBe('with_photo')
    expect(productFlag(false, false)).toBe('')
  })
})
