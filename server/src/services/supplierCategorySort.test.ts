import { beforeEach, describe, expect, it, vi } from 'vitest'

// 26.11.2026, власник: «товари, що прийшли по API й ще прийдуть, не розсортовані; на сайті невідомо як показуватимуться».
const sql = vi.hoisted(() => ({ calls: [] as Array<{ text: string; params: any[] }>, offers: [] as any[], rules: [] as any[] }))
vi.mock('../db/pg.js', () => ({ pool: { query: async (text: string, params: any[] = []) => {
  sql.calls.push({ text, params })
  if (/FROM supplier_offers\s+WHERE tenant_id = \$1 AND category_id IS NULL/.test(text)) return { rows: sql.offers }
  if (/FROM supplier_category_rules WHERE/.test(text)) return { rows: sql.rules }
  return { rows: [], rowCount: 0 }
} } }))
import { sortPage, type SortModel } from './supplierCategorySort.js'
import { agreedCategory, categoryKey, categoryOptions, newCategoryName, parseMergeReply, parseSortReply, sortLine, sortPrompt } from './supplierCategoryKey.js'
import { AiExecutionBudget } from './aiExecutionBudget.js'

const options = categoryOptions([
  { id: 'c-filters', parent_id: null, name: 'Фільтри' }, { id: 'c-air', parent_id: 'c-filters', name: 'Повітряні' },
  { id: 'c-brakes', parent_id: null, name: 'Гальмівна система' }, { id: 'c-spark', parent_id: null, name: 'Свічки' },
])
const number = (id: string) => options.findIndex(option => option.id === id) + 1
const offer = (external: string, name: string, category: string | null = null) => ({ connection_id: 'conn', external_id: external, name, category_name: category })
const changes = () => sql.calls.filter(call => /UPDATE supplier_offers o SET category_id/.test(call.text)).flatMap(call => JSON.parse(call.params[1]) as Array<{ external_id: string; category_id: string | null; source: string }>)
const savedRules = () => sql.calls.filter(call => /INSERT INTO supplier_category_rules/.test(call.text)).flatMap(call => JSON.parse(call.params[1]) as Array<{ key: string; category_id: string | null }>)

describe('kind of a supplier product', () => {
  it('the supplier category when it says something; otherwise the first words of the name (letter «s» check)', () => {
    expect(categoryKey({ name: 'Фільтр повітряний AUTOMEGA s', category_name: 'Повітряні фільтри' })).toBe('cat:повітряні фільтри')
    expect(categoryKey({ name: 'Свічка запалювання PLATINUM RENAULT SCENIC III 1.4 TCE 09- (вир-во CHAMPION)', category_name: 'Під замовлення' })).toBe('name:свічка запалювання')
    expect(categoryKey({ name: 'Диск гальмівний (вир-во REMSA)', category_name: null })).toBe('name:диск гальмівний')
    expect(categoryKey({ name: 'Крило пер. лів. SK OCTAVIA 05-09 (TEMPEST)' })).toBe('name:крило пер')
    expect(categoryKey({ name: 'Зчеплення CITROEN C4-C5-C8' })).toBe('name:зчеплення')
    expect(categoryKey({ name: 'Барабан гальмівний ВАЗ 2108' })).toBe('name:барабан гальмівний')
  })

  it('a name that starts with a brand or a code gives no kind — such a product stays without a category', () => {
    expect(categoryKey({ name: 'VALEO VL 700431 5 13348 40 Дросельна заслонка' })).toBeNull()
    expect(categoryKey({ name: 'Р/к супорта' })).toBeNull()
    expect(categoryKey({ name: '', category_name: '' })).toBeNull()
  })

  it('the category list shows the tree; the answer is read by numbers; two votes must agree', () => {
    expect(options.map(option => option.path)).toEqual(['Гальмівна система', 'Свічки', 'Фільтри', 'Фільтри › Повітряні'])
    expect(sortPrompt(options)).toContain('4. Фільтри › Повітряні')
    expect(sortLine(2, 'name:диск гальмівний', ['Диск гальмівний (вир-во REMSA)'])).toBe('№2 | назви починаються з «диск гальмівний» | приклади: Диск гальмівний (вир-во REMSA)')
    expect([...parseSortReply('ок {"items":[{"n":1,"c":4},{"n":2,"c":9},{"n":7,"c":1},{"n":1,"c":2}]}', 2, 4)]).toEqual([[1, { c: 4, name: '' }]])
    const vote = (c: number, name = '') => ({ c, name })
    expect(agreedCategory(vote(3), vote(3))).toEqual(vote(3))
    expect(agreedCategory(vote(3), vote(2))).toEqual(vote(0))
    expect(agreedCategory(undefined, vote(2))).toEqual(vote(0))
  })

  // 27.11.2026, власник: «якщо в нас такої категорії немає, то він її створює».
  it('a new category is proposed only when both answers say «new»; its name must be plain Ukrainian words', () => {
    const votes = parseSortReply('{"items":[{"n":1,"c":-1,"new":"кузовні деталі"},{"n":2,"c":-1,"new":"BOSCH R16"},{"n":3,"c":-1}]}', 3, 4)
    expect(votes.get(1)).toEqual({ c: -1, name: 'Кузовні деталі' })
    expect(votes.get(2)).toEqual({ c: 0, name: '' })
    expect(votes.get(3)).toEqual({ c: 0, name: '' })
    expect(agreedCategory({ c: -1, name: 'Кузовні деталі' }, { c: -1, name: 'Деталі кузова' })).toEqual({ c: -1, name: 'Кузовні деталі' })
    expect(agreedCategory({ c: -1, name: 'Кузовні деталі' }, { c: 2, name: '' })).toEqual({ c: 0, name: '' })
    expect(newCategoryName(' «Системи кондиціонування». ')).toBe('Системи кондиціонування')
    expect(newCategoryName('Шини 205/55')).toBe('')
    expect(sortPrompt(options)).toContain('став -1')
  })

  it('merging proposals: each proposal goes to one group at most; an existing category wins; broken groups are dropped', () => {
    const groups = parseMergeReply('{"groups":[{"name":"кузовні деталі","existing":0,"from":[1,2,9]},{"existing":3,"from":[3,1]},{"name":"X5","from":[4]},{"name":"Порожня","from":[]}]}', 4, 4)
    expect(groups).toEqual([{ name: 'Кузовні деталі', existing: 0, from: [1, 2] }, { name: '', existing: 3, from: [3] }])
    expect(parseMergeReply('не JSON', 3, 3)).toEqual([])
  })
})

describe('one page of the category sort', () => {
  beforeEach(() => { sql.calls.length = 0; sql.rules = [] })
  const model = (answers: string[]): SortModel => { let turn = 0; return { complete: vi.fn(async () => ({ text: answers[turn++ % answers.length], truncated: false, promptTokens: 10, completionTokens: 5 })) } }

  it('a known kind is placed without asking; a new kind needs two agreeing answers; no kind — left without a category', async () => {
    sql.offers = [offer('1', 'Фільтр повітряний WIX', 'Повітряні фільтри'), offer('2', 'Диск гальмівний (вир-во REMSA)'), offer('3', 'Диск гальмівний BREMBO'), offer('4', 'Свічка запалювання NGK'), offer('5', 'VALEO 700431')]
    sql.rules = [{ key: 'cat:повітряні фільтри', category_id: 'c-air', new_name: null }]
    // Невідомі види за частотою: №1 «диск гальмівний» (2 товари), №2 «свічка запалювання». Про свічку відповіді розійшлись.
    const first = JSON.stringify({ items: [{ n: 1, c: number('c-brakes') }, { n: 2, c: number('c-spark') }] })
    const second = JSON.stringify({ items: [{ n: 1, c: number('c-brakes') }, { n: 2, c: number('c-filters') }] })
    const sorter = model([first, second])
    const budget = new AiExecutionBudget(10_000)
    let page
    try { page = await sortPage('shop', options, sorter, budget) } finally { budget.dispose() }
    expect(sorter.complete).toHaveBeenCalledTimes(2)
    expect(savedRules()).toEqual([{ key: 'name:диск гальмівний', category_id: 'c-brakes', new_name: null, sample: 'Диск гальмівний (вир-во REMSA)' }, { key: 'name:свічка запалювання', category_id: null, new_name: null, sample: 'Свічка запалювання NGK' }])
    expect(Object.fromEntries(changes().map(change => [change.external_id, [change.category_id, change.source]]))).toEqual({
      1: ['c-air', 'ai'], 2: ['c-brakes', 'ai'], 3: ['c-brakes', 'ai'], 4: [null, 'ai_none'], 5: [null, 'ai_none'],
    })
    expect(page).toMatchObject({ offers: 5, placed: 3, asked: 2 })
  })

  // 26.11.2026: пара моделей — основна (Sonnet) і помічниця (Haiku) голосують окремо; категорія лише там, де зійшлись.
  it('two different models vote: each is asked once, with its own effort; a disagreement leaves the kind without a category', async () => {
    sql.offers = [offer('2', 'Диск гальмівний s REMSA'), offer('4', 'Свічка запалювання NGK')]
    sql.rules = []
    const main = model([JSON.stringify({ items: [{ n: 1, c: number('c-brakes') }, { n: 2, c: number('c-spark') }] })])
    const helper = model([JSON.stringify({ items: [{ n: 1, c: number('c-brakes') }, { n: 2, c: number('c-filters') }] })])
    const budget = new AiExecutionBudget(10_000)
    let page
    try { page = await sortPage('shop', options, main, budget, helper) } finally { budget.dispose() }
    expect(main.complete).toHaveBeenCalledTimes(1)
    expect(helper.complete).toHaveBeenCalledTimes(1)
    expect((main.complete as any).mock.calls[0][1].effort).toBe('low')
    expect((helper.complete as any).mock.calls[0][1].effort).toBe('medium')
    expect(page).toMatchObject({ offers: 2, placed: 1, asked: 2 })
    expect(page!.usage).toHaveLength(2)
  })

  it('no fitting category: products wait for a new one (not «unsure»); a proposed name equal to an existing category is that category', async () => {
    sql.offers = [offer('1', 'Крило пер. лів. SK OCTAVIA'), offer('2', 'Крило пер. прав. VW GOLF'), offer('3', 'Свічка запалювання NGK')]
    const answer = JSON.stringify({ items: [{ n: 1, c: -1, new: 'Кузовні деталі' }, { n: 2, c: -1, new: 'свічки' }] })
    const budget = new AiExecutionBudget(10_000)
    try { await sortPage('shop', options, model([answer]), budget) } finally { budget.dispose() }
    expect(savedRules()).toEqual([{ key: 'name:крило пер', category_id: null, new_name: 'Кузовні деталі', sample: 'Крило пер. лів. SK OCTAVIA' }, { key: 'name:свічка запалювання', category_id: 'c-spark', new_name: null, sample: 'Свічка запалювання NGK' }])
    expect(Object.fromEntries(changes().map(change => [change.external_id, [change.category_id, change.source]]))).toEqual({ 1: [null, 'ai_wait'], 2: [null, 'ai_wait'], 3: ['c-spark', 'ai'] })
  })

  it('nothing to sort — the model is not asked and nothing is written', async () => {
    sql.offers = []
    const sorter = model(['{}'])
    const budget = new AiExecutionBudget(10_000)
    try { expect(await sortPage('shop', options, sorter, budget)).toEqual({ offers: 0, placed: 0, usage: [], asked: 0 }) } finally { budget.dispose() }
    expect(sorter.complete).not.toHaveBeenCalled()
    expect(changes()).toEqual([])
  })
})
