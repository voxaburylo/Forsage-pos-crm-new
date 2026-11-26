import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { exactProductMatch, fitSide, groupPhotoFiles, isoToLocalInput, localInputToIso, photoFileKey, siteOrderToProgramOrder, type SiteOrder } from './siteGateway'
import { BANNERS, CATEGORIES, PAGES, PROMOS, formProblem, formToPayload, rowToForm } from './SiteCrudTab'
import { SITE_SETTING_FIELDS, SITE_SETTING_GROUPS, completeHomeBlocks } from './SiteSimpleTabs'
import { specsFromText, specsToText } from './SiteProductsTab'
import { SITE_SECTIONS, SITE_TABS } from './SitePage'

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
const P1 = '7b1f0c1e-2a3b-4c4d-8e5f-0123456789ab'

// 24.11.2026: розділ «Сайт» керує сайтом forsage-tires.com через шлюз (контракт розробника сайту).
describe('site section through the gateway', () => {
  const order: SiteOrder = { id: 'A-102', created_at: '2026-11-24T10:00:00Z', status: 'new', customer_name: ' Іван ', customer_phone: '+38 (050) 123-45-67',
    delivery_method: 'Нова пошта', city: 'Київ', warehouse: '№12', comment: 'після 18', total: 1500,
    items: [{ program_product_id: P1, title: 'Олива 5W-40', qty: 2, price: 450.5 }, { program_product_id: null, title: 'Шина 205/55 R16', qty: 4, price: 150 }] }

  it('a site order becomes a program order form: catalog goods as rows in kopecks, tyres as a note, no money', () => {
    const { payload, textOnly } = siteOrderToProgramOrder(order)
    expect(payload.items).toEqual([{ name: 'Олива 5W-40', qty: 2, sell_price: 45050, product_id: P1 }])
    expect(payload).toMatchObject({ customer_phone: '380501234567', customer_name: 'Іван', author: 'Сайт' })
    expect(payload.comment).toContain('Замовлення із сайту № A-102')
    expect(payload.comment).toContain('Доставка: Нова пошта, Київ, №12')
    expect(payload.comment).toContain('Шина 205/55 R16 — 4 шт')
    expect(textOnly).toHaveLength(1)
    expect(JSON.stringify(payload)).not.toMatch(/prepay|payment|paid/)
    expect(siteOrderToProgramOrder({ ...order, customer_phone: '123', items: [] }).payload).toMatchObject({ customer_phone: null, items: [] })
  })

  it('creating in the program goes the same safe way as a phone order, never by writing to the cloud', () => {
    const tab = read('./SiteOrdersTab.tsx')
    expect(tab).toContain("command: 'order.save'")
    expect(tab).toContain('tillOrderToCreate(checked, null, operationId')
    expect(tab).not.toMatch(/customer_orders|supabase/)
  })

  it('photos keep proportions, are never enlarged, and file names map to an article or barcode', () => {
    expect(fitSide(4000, 3000, 1000)).toEqual({ width: 1000, height: 750 })
    expect(fitSide(300, 600, 400)).toEqual({ width: 200, height: 400 })
    expect(fitSide(200, 100, 1000)).toEqual({ width: 200, height: 100 })
    for (const [name, key] of [['WB-1065.jpg', 'WB-1065'], ['WB-1065_2.JPG', 'WB-1065'], ['WB-1065 (3).png', 'WB-1065'], ['C:\\фото\\4820001.webp', '4820001'], ['BP-12502.jpeg', 'BP-12502']])
      expect(photoFileKey(name), name).toBe(key)
    const groups = groupPhotoFiles([{ name: 'wb-1065_2.jpg' }, { name: 'readme.txt' }, { name: 'WB-1065.jpg' }, { name: '4820001.png' }])
    expect([...groups.keys()]).toEqual(['4820001', 'wb-1065'])
    expect(groups.get('wb-1065')!.map(file => file.name)).toEqual(['WB-1065.jpg', 'wb-1065_2.jpg'])
  })

  it('a photo goes only to an exact article or barcode match, never to a similar or ambiguous card', () => {
    const cards = [{ id: 'a', sku: 'WB-1065', barcode: null }, { id: 'b', sku: 'WB-10650', barcode: '4820001' }]
    expect(exactProductMatch('wb-1065', cards)?.id).toBe('a')
    expect(exactProductMatch('4820001', cards)?.id).toBe('b')
    expect(exactProductMatch('WB-106', cards)).toBeNull()
    expect(exactProductMatch('x', [{ sku: 'X' }, { sku: 'x' }])).toBeNull()
  })

  it('forms send numbers as numbers, dates as ISO, lists as lists and catch what is missing', () => {
    const form = rowToForm(PROMOS.fields, { id: 'p1', title: 'Зима', discount_percent: 7, target_type: 'brand', target_ids: ['b1', 'b2'], is_active: false, starts_at: '2026-11-24T10:00:00.000Z' })
    expect(form).toMatchObject({ id: 'p1', discount_percent: '7', target_ids: 'b1, b2', is_active: false })
    expect(localInputToIso(String(form.starts_at))).toBe('2026-11-24T10:00:00.000Z')
    expect(formToPayload(PROMOS.fields, { ...form, discount_percent: '7,5', target_ids: 'b1; b2 b3', ends_at: '' })).toMatchObject({ id: 'p1', discount_percent: 7.5, target_ids: ['b1', 'b2', 'b3'], ends_at: null, starts_at: '2026-11-24T10:00:00.000Z' })
    expect(formProblem(BANNERS.fields, rowToForm(BANNERS.fields, BANNERS.empty()))).toBe('Заповніть поле «Заголовок»')
    expect(formProblem(PROMOS.fields, { title: 'x', discount_percent: 'abc' })).toContain('потрібне число')
    expect(formProblem(BANNERS.fields, { title: 'x', starts_at: '2026-12-02T10:00', ends_at: '2026-12-01T10:00' })).toBe('Дата початку пізніша за дату кінця')
    expect(formProblem(BANNERS.fields, { title: 'x', starts_at: '2026-12-01T10:00', ends_at: '2026-12-02T10:00' })).toBe('')
    expect(isoToLocalInput('nope')).toBe(''); expect(localInputToIso('')).toBeNull()
    expect(formToPayload(CATEGORIES.fields, rowToForm(CATEGORIES.fields, { name: 'Інструмент', program_category_ids: ['c1', 'c2'] }))).toMatchObject({ name: 'Інструмент', program_category_ids: ['c1', 'c2'], parent_id: null, is_active: true })
  })

  it('info pages can only be edited; the home page keeps every block and unknown ones too', () => {
    expect(PAGES.fixed?.({ type: 'info' })).toBe(true); expect(PAGES.fixed?.({ type: 'article' })).toBe(false)
    const blocks = completeHomeBlocks([{ type: 'hits', enabled: true, title: 'Хіти' }, { type: 'new_block', enabled: 1 }, null, 'x'])
    expect(blocks.slice(0, 2)).toEqual([{ type: 'hits', enabled: true, title: 'Хіти' }, { type: 'new_block', enabled: true }])
    expect(blocks.map(block => block.type).sort()).toEqual(['articles', 'banners', 'benefits', 'categories', 'hits', 'new_block', 'promos', 'reviews', 'size_search'])
    expect(completeHomeBlocks(undefined)).toHaveLength(8)
  })

  it('characteristics are typed one per line; the settings and tabs match the contract and the server list', () => {
    expect(specsFromText('Вʼязкість: 5W-40\nбез двокрапки\n: порожній ключ\nОбʼєм:  4 л ')).toEqual({ 'Вʼязкість': '5W-40', 'Обʼєм': '4 л' })
    expect(specsToText({ a: 1, b: 'x' })).toBe('a: 1\nb: x'); expect(specsToText(null)).toBe('')
    const server = read('../../../../../server/src/services/siteGatewayService.ts')
    for (const field of SITE_SETTING_FIELDS) expect(server, field.key).toContain(`'${field.key}'`)
    expect(SITE_SETTING_FIELDS).toHaveLength(13)
    // Кожне поле — рівно в одній групі (інакше поле зникло б з екрана).
    expect(SITE_SETTING_GROUPS.flatMap(group => group.keys).sort()).toEqual(SITE_SETTING_FIELDS.map(field => field.key).sort())
    // 26.11.2026, слово власника: «чітка ієрархія: товари — уся робота з товарами; замовлення — уся робота із замовленнями».
    expect(SITE_SECTIONS.map(section => [section.label, section.tabs.map(tab => tab.label)])).toEqual([
      // 26.11.2026: «товари → категорії → товари в категорії»: категорії — ліворуч у «Товарах»; меню сайту — у «Вітрині».
      ['Товари', ['Товари за категоріями', 'Фото', 'Акції']],
      ['Замовлення', ['Замовлення', 'Покупці', 'Відгуки']],
      ['Вітрина', ['Головна сторінка', 'Меню каталогу', 'Банери', 'Сторінки і статті']],
      // 26.11.2026: ШІ-помічник сайту (SEO, описи, форум).
      ['ШІ-помічник', ['Просування сайту']],
      ['Налаштування', ['Налаштування сайту', 'Каталог для сайту', 'Доступ']],
    ])
    expect(new Set(SITE_TABS.map(tab => tab.id)).size).toBe(SITE_TABS.length)
  })

  it('no second products tab: our product opens its site page (photos, description) from «All products»', () => {
    const page = read('./SitePage.tsx'), list = read('./SiteAllProductsTab.tsx')
    expect(page).not.toContain("label: 'Товари на сайті'")
    expect(page).not.toContain('SiteProductsTab }')
    expect(list).toContain("row.kind === 'ours' ? setOwn(row) : setOffer(row.id)")
    expect(list).not.toContain("row.kind === 'ours' ? navigate(")
    expect(list).toContain('<ProductEditor product=')
    expect(read('./SiteProductsTab.tsx')).toContain('export function SitePhotosTab()')
  })

  it('the site key never reaches the window: it calls only its own server', () => {
    for (const file of ['./siteGateway.ts', './SitePage.tsx', './SiteOrdersTab.tsx', './SiteCrudTab.tsx', './SiteSimpleTabs.tsx', './SiteProductsTab.tsx']) {
      expect(read(file), file).not.toMatch(/x-site-key|SITE_API_KEY|functions\/v1\/site-api/)
    }
    expect(read('./siteGateway.ts')).toContain("'/api/v1/site-admin/gateway'")
  })
})

// 24.11.2026 (слово власника: «вкладка мала, зверху повзунок, вкладки порожні й незрозумілі; „Внутрішні витрати“ зайві під рукою»).
describe('site section is readable and the menu is not cluttered', () => {
  it('every tab says what it is for; the link state is told in one line', async () => {
    const { SITE_TAB_INTRO, siteLinkText } = await import('./SitePage')
    for (const tab of SITE_TABS) expect(SITE_TAB_INTRO[tab.id].length, tab.id).toBeGreaterThan(40)
    expect(siteLinkText({ site: 'forsage-tires.com', catalog_sync: { minutes_since_ok: 1, stale: false, last_error: null } }))
      .toEqual({ state: 'ok', text: 'Сайт forsage-tires.com на звʼязку. Товари, ціни й залишки з програми забрав 1 хв тому.' })
    expect(siteLinkText({ site: 'x', catalog_sync: { minutes_since_ok: 300, stale: true } })).toMatchObject({ state: 'stale' })
    expect(siteLinkText({ site: 'x', catalog_sync: { minutes_since_ok: 300, stale: true } }).text).toContain('5 год тому')
    expect(siteLinkText(null).state).toBe('down')
  })
  it('info pages have names even before the owner writes them; empty lists explain what to do', () => {
    expect(PAGES.title({ id: 'delivery', type: 'info', slug: 'delivery', title: null })).toBe('Доставка')
    expect(PAGES.title({ id: 'x', type: 'article', title: 'Як вибрати шини' })).toBe('Як вибрати шини')
    for (const config of [BANNERS, PROMOS, PAGES, CATEGORIES]) expect(config.emptyText.length, config.name).toBeGreaterThan(25)
    expect(CATEGORIES.subtitle?.({ id: 6, kind: 'tyre', parent_id: 1 })).toContain('веде сам сайт')
    // Сайт нумерує категорії числами: «усередині якої» йде числом, а не рядком.
    expect(formToPayload(CATEGORIES.fields, rowToForm(CATEGORIES.fields, { id: 20, name: 'Фільтри', parent_id: 1, program_category_ids: [] }))).toMatchObject({ id: 20, parent_id: 1 })
  })
  it('the section uses the page width, tabs wrap on a PC; internal consumption left the menu for the inventory tabs', () => {
    const page = read('./SitePage.tsx')
    expect(page).toContain('className="w-full space-y-3" data-site-body')
    expect(page).toContain('max-lg:overflow-x-auto lg:flex-wrap')
    expect(page).not.toContain('max-w-4xl')
    expect(read('../../components/Sidebar.tsx')).not.toMatch(/to: '\/internal'/)
    expect(read('../../components/SubNavTabs.tsx')).toMatch(/to: '\/internal', label: 'Для потреб магазину'/)
    // «Автозакупівля» — так само: не пункт меню, а вкладка в «Постачальники».
    expect(read('../../components/Sidebar.tsx')).not.toMatch(/to: '\/auto-purchase'/)
    expect(read('../../components/SubNavTabs.tsx')).toMatch(/to: '\/auto-purchase', label: 'Автозакупівля'/)
  })
})
