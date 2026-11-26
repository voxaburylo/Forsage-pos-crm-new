import { beforeEach, describe, expect, it, vi } from 'vitest'

// 27.11.2026, власник: «якщо в нас такої категорії немає, то він її створює».
// Категорії — дані каси: сервер зводить пропозиції, ставить касі команду й чекає, поки категорія прийде в хмару.
const sql = vi.hoisted(() => ({ calls: [] as Array<{ text: string; params: any[] }>, rules: [] as any[], offers: [] as any[], waiting: [] as any[] }))
vi.mock('../db/pg.js', () => ({ pool: { query: async (text: string, params: any[] = []) => {
  sql.calls.push({ text, params })
  if (/SELECT key, new_name FROM supplier_category_rules/.test(text)) return { rows: sql.rules }
  if (/SELECT name, category_name FROM supplier_offers/.test(text)) return { rows: sql.offers }
  if (/SELECT DISTINCT new_name FROM supplier_category_rules/.test(text)) return { rows: sql.waiting }
  return { rows: [], rowCount: 1 }
} } }))
const wake = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('./tillWake.js', () => ({ wakeTill: wake }))
import { mergeNewCategories, resolveNewCategories } from './supplierCategoryNew.js'
import { categoryOptions } from './supplierCategoryKey.js'
import { AiExecutionBudget } from './aiExecutionBudget.js'

const options = categoryOptions([{ id: 'c-spark', parent_id: null, name: 'Свічки' }, { id: 'c-body', parent_id: null, name: 'Оптика' }])
const queued = () => sql.calls.filter(call => /INSERT INTO till_commands/.test(call.text)).map(call => call.params[1])
const ruleUpdates = () => sql.calls.filter(call => /UPDATE supplier_category_rules SET/.test(call.text)).map(call => [call.text.replace(/\s+/g, ' ').match(/SET (.*?) WHERE/)![1], call.params.slice(1)])
const many = (count: number, name: string) => Array.from({ length: count }, (_, index) => ({ name: `${name} ${index} s`, category_name: null }))

describe('new categories for supplier products', () => {
  beforeEach(() => { sql.calls.length = 0; wake.mockClear() })

  it('similar proposals become one category ordered from the till; a tiny group and a leftover get no category', async () => {
    sql.rules = [{ key: 'name:крило пер', new_name: 'Кузовні деталі' }, { key: 'name:капот двигуна', new_name: 'Деталі кузова' }, { key: 'name:рідкісна штука', new_name: 'Рідкісне' }, { key: 'name:фара ліва', new_name: 'Фари' }]
    sql.offers = [...many(10, 'Крило пер. лів.'), ...many(8, 'Капот двигуна'), ...many(2, 'Рідкісна штука'), ...many(20, 'Фара ліва')]
    // Пропозиції за кількістю товарів: №1 «Фари» (20), №2 «Кузовні деталі» (10), №3 «Деталі кузова» (8), №4 «Рідкісне» (2).
    const model = { complete: vi.fn(async () => ({ text: JSON.stringify({ groups: [{ name: 'Кузовні деталі', existing: 0, from: [2, 3] }, { existing: 1, from: [1] }, { name: 'Рідкісні товари', existing: 0, from: [4] }] }), truncated: false, promptTokens: 1, completionTokens: 1 })) }
    const budget = new AiExecutionBudget(10_000)
    let made
    try { made = await mergeNewCategories('shop', 'owner', options, model, budget) } finally { budget.dispose() }
    expect(made?.created).toEqual(['Кузовні деталі'])
    expect(queued()).toEqual(['Кузовні деталі'])
    expect(ruleUpdates()).toEqual([
      ['new_name = $3, new_final = true', [['Кузовні деталі', 'Деталі кузова'], 'Кузовні деталі']],
      ['category_id = $3, new_name = NULL', [['Фари'], 'c-body']],
      ['new_name = NULL', []],
    ])
    // Товари, що чекали, повертаються в чергу розкладки.
    expect(sql.calls.some(call => /UPDATE supplier_offers SET category_source = NULL/.test(call.text))).toBe(true)
    expect(wake).toHaveBeenCalledWith('shop')
  })

  it('no proposals — the model is not asked', async () => {
    sql.rules = []
    const model = { complete: vi.fn() }
    const budget = new AiExecutionBudget(10_000)
    try { expect(await mergeNewCategories('shop', 'owner', options, model as never, budget)).toBeNull() } finally { budget.dispose() }
    expect(model.complete).not.toHaveBeenCalled()
  })

  it('a category the till has created is taken into use; one still missing is asked from the till again', async () => {
    sql.waiting = [{ new_name: 'свічки' }, { new_name: 'Кузовні деталі' }]
    expect(await resolveNewCategories('shop', 'owner', options)).toEqual({ resolved: 1, queued: 1 })
    expect(ruleUpdates()).toEqual([['category_id = $3, new_name = NULL, new_final = false', ['свічки', 'c-spark']]])
    expect(queued()).toEqual(['Кузовні деталі'])
    expect(sql.calls.some(call => /UPDATE supplier_offers SET category_source = NULL/.test(call.text))).toBe(true)
  })
})
