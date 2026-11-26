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
import { agreedCategory, categoryKey, categoryOptions, parseSortReply, sortLine, sortPrompt } from './supplierCategoryKey.js'
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
    expect([...parseSortReply('ок {"items":[{"n":1,"c":4},{"n":2,"c":9},{"n":7,"c":1},{"n":1,"c":2}]}', 2, 4)]).toEqual([[1, 4]])
    expect(agreedCategory(3, 3)).toBe(3)
    expect(agreedCategory(3, 2)).toBe(0)
    expect(agreedCategory(undefined, 2)).toBe(0)
  })
})

describe('one page of the category sort', () => {
  beforeEach(() => { sql.calls.length = 0; sql.rules = [] })
  const model = (answers: string[]): SortModel => { let turn = 0; return { complete: vi.fn(async () => ({ text: answers[turn++ % answers.length], truncated: false, promptTokens: 10, completionTokens: 5 })) } }

  it('a known kind is placed without asking; a new kind needs two agreeing answers; no kind — left without a category', async () => {
    sql.offers = [offer('1', 'Фільтр повітряний WIX', 'Повітряні фільтри'), offer('2', 'Диск гальмівний (вир-во REMSA)'), offer('3', 'Диск гальмівний BREMBO'), offer('4', 'Свічка запалювання NGK'), offer('5', 'VALEO 700431')]
    sql.rules = [{ key: 'cat:повітряні фільтри', category_id: 'c-air' }]
    // Невідомі види за частотою: №1 «диск гальмівний» (2 товари), №2 «свічка запалювання». Про свічку відповіді розійшлись.
    const first = JSON.stringify({ items: [{ n: 1, c: number('c-brakes') }, { n: 2, c: number('c-spark') }] })
    const second = JSON.stringify({ items: [{ n: 1, c: number('c-brakes') }, { n: 2, c: number('c-filters') }] })
    const sorter = model([first, second])
    const budget = new AiExecutionBudget(10_000)
    let page
    try { page = await sortPage('shop', options, sorter, budget) } finally { budget.dispose() }
    expect(sorter.complete).toHaveBeenCalledTimes(2)
    expect(savedRules()).toEqual([{ key: 'name:диск гальмівний', category_id: 'c-brakes', sample: 'Диск гальмівний (вир-во REMSA)' }, { key: 'name:свічка запалювання', category_id: null, sample: 'Свічка запалювання NGK' }])
    expect(Object.fromEntries(changes().map(change => [change.external_id, [change.category_id, change.source]]))).toEqual({
      1: ['c-air', 'ai'], 2: ['c-brakes', 'ai'], 3: ['c-brakes', 'ai'], 4: [null, 'ai_none'], 5: [null, 'ai_none'],
    })
    expect(page).toMatchObject({ offers: 5, placed: 3, asked: 2 })
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
