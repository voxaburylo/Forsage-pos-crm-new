import { beforeEach, describe, expect, it, vi } from 'vitest'

// 26.11.2026, власник: «великі пачки, без купи підтверджень, тільки щоб він не робив дурниць».
// База підмінена: перевіряємо рішення пачки — що йде на сайт саме, що відкладається, що не чіпається.
const sql = vi.hoisted(() => ({ calls: [] as Array<{ text: string; params: any[] }>, facts: [] as any[], attempts: 1 }))
vi.mock('../db/pg.js', () => ({ pool: { query: async (text: string, params: any[] = []) => {
  sql.calls.push({ text, params })
  if (/FROM products p LEFT JOIN brands/.test(text)) return { rows: sql.facts }
  if (/SELECT attempts FROM site_text_items/.test(text)) return { rows: [{ attempts: sql.attempts }] }
  return { rows: [], rowCount: 0 }
} } }))
import { processTextChunk, type TextGateway, type TextModel } from './siteTextJobService.js'
import { AiExecutionBudget } from './aiExecutionBudget.js'

const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const row = { id: 'job', tenant_id: 'shop', created_by: 'owner', overwrite: false, style_note: null }
const item = (n: number, name: string) => ({ product_id: id(n), seq: n, name, state: 'working', new_fields: null, old_fields: null })
const fact = (n: number, name: string, sku: string) => ({ id: id(n), name, sku, unit: 'шт', oem_number: '', specs: {}, brand: 'Castrol', category: 'Моторні оливи', crosses: null })
const cleanText = (volume: string) => ({
  description: `Моторна олива Castrol Magnatec 5W-40 у каністрі ${volume}. Підходить для двигунів, де виробник авто вимагає вʼязкість 5W-40. Перед купівлею звірте вʼязкість із сервісною книжкою вашого авто.`,
  seo_title: `Олива Castrol Magnatec 5W-40 ${volume} — моторна`,
  seo_description: `Моторна олива Castrol Magnatec 5W-40, каністра ${volume}. Замовляйте з доставкою по Україні, підберемо під ваше авто.`,
})
const states = () => sql.calls.filter(call => /UPDATE site_text_items SET state = \$3/.test(call.text)).map(call => [call.params[1], call.params[2], call.params[3]])
function setup(reply: unknown, site: Record<string, Record<string, unknown>> = {}) {
  const sets: Array<Record<string, unknown>> = []
  const gateway: TextGateway = vi.fn(async (_user, action, params) => {
    if (action === 'products.site_fields.get') return site[String(params.program_product_id)] ?? { description: '', specs: { size: '4л' }, hidden: true }
    sets.push(...(params.items as Array<Record<string, unknown>>)); return { saved: 1, not_on_site: [] }
  })
  const model: TextModel = { complete: vi.fn(async () => ({ text: JSON.stringify(reply), truncated: false, promptTokens: 100, completionTokens: 200 })) }
  return { gateway, model, sets }
}

describe('one batch of the mass product-text job', () => {
  beforeEach(() => { sql.calls.length = 0; sql.attempts = 1 })

  it('a clean text goes to the site by itself (site specs and «hidden» kept); an invented volume is held for the owner', async () => {
    sql.facts = [fact(1, 'Олива моторна Castrol Magnatec 5W-40 4л s', '15C9D0'), fact(2, 'Олива моторна Castrol Magnatec 5W-40 1л', '15C9D1')]
    const { gateway, model, sets } = setup({ items: [{ n: 1, ...cleanText('4 л') }, { n: 2, ...cleanText('5 л') }] })
    const budget = new AiExecutionBudget(10_000)
    try { await processTextChunk(row, [item(1, 'a'), item(2, 'b')], false, model, gateway, budget) } finally { budget.dispose() }
    expect(sets).toHaveLength(1)
    // Запис — дією seo.products.set: лише поля для Google і опис; характеристики й «сховано» товару не чіпаються взагалі.
    expect(sets[0]).toEqual({ program_product_id: id(1), seo_title: 'Олива Castrol Magnatec 5W-40 4 л — моторна', seo_description: cleanText('4 л').seo_description, seo_keywords: '', description: cleanText('4 л').description })
    const result = Object.fromEntries(states().map(([product, state, note]) => [product, [state, note]]))
    expect(result[id(1)]).toEqual(['written', null])
    expect(result[id(2)][0]).toBe('review')
    expect(result[id(2)][1]).toMatch(/розмір чи обʼєм, якого немає в даних товару: 5 л/)
  })

  it('a product that already has a description on the site is left alone and the model is not asked about it', async () => {
    sql.facts = [fact(1, 'Олива моторна Castrol Magnatec 5W-40 4л', '15C9D0')]
    const { gateway, model, sets } = setup({ items: [] }, { [id(1)]: { description: 'Опис, який власник написав сам і який помічник не має права перезаписати без прямого прохання.', seo_title: 'Заголовок власника', seo_description: 'Опис власника для пошуковика' } })
    const budget = new AiExecutionBudget(10_000)
    try { expect(await processTextChunk(row, [item(1, 'a')], false, model, gateway, budget)).toBeNull() } finally { budget.dispose() }
    expect(model.complete).not.toHaveBeenCalled()
    expect(sets).toEqual([])
    expect(states()).toEqual([[id(1), 'skipped', 'на сайті вже все заповнено']])
  })

  // 27.11.2026, «Доповнення 5»: товари зі списку сайту (seo.products.missing) — без окремого запиту про кожен товар.
  it('a product from the site list: its own description is kept, only the Google fields and keywords are written; «not on site» is skipped', async () => {
    sql.facts = [fact(1, 'Олива моторна Castrol Magnatec 5W-40 4л', '15C9D0'), fact(2, 'Олива моторна Castrol Magnatec 5W-40 4л', '15C9D1')]
    const sets: Array<Record<string, unknown>> = []
    const gateway: TextGateway = vi.fn(async (_user, action, params) => {
      if (action !== 'seo.products.set') throw new Error('unexpected ' + action)
      const item = (params.items as Array<Record<string, unknown>>)[0]
      sets.push(item)
      return item.program_product_id === id(2) ? { saved: 0, not_on_site: [id(2)] } : { saved: 1, not_on_site: [] }
    })
    const text = { ...cleanText('4 л'), seo_keywords: 'моторна олива 5W-40, Castrol Magnatec, олива 4 л' }
    const model: TextModel = { complete: vi.fn(async () => ({ text: JSON.stringify({ items: [{ n: 1, ...text }, { n: 2, ...text }] }), truncated: false, promptTokens: 1, completionTokens: 1 })) }
    const listed = (n: number, has: boolean) => ({ ...item(n, 'a'), old_fields: { from_site_list: true, has_description: has, seo_title: '', seo_description: '' } })
    const budget = new AiExecutionBudget(10_000)
    try { await processTextChunk(row, [listed(1, true), listed(2, false)], false, model, gateway, budget) } finally { budget.dispose() }
    expect(sets[0]).toEqual({ program_product_id: id(1), seo_title: text.seo_title, seo_description: text.seo_description, seo_keywords: text.seo_keywords })
    expect(sets[1]).toHaveProperty('description')
    expect(Object.fromEntries(states().map(([product, state, note]) => [product, [state, note]]))).toEqual({ [id(1)]: ['written', null], [id(2)]: ['skipped', 'цього товару немає на сайті'] })
  })

  it('samples are never written to the site; a missing answer returns the product to the queue, then gives up', async () => {
    sql.facts = [fact(1, 'Олива моторна Castrol Magnatec 5W-40 4л', '15C9D0'), fact(2, 'Олива моторна Castrol Magnatec 5W-40 1л', '15C9D1')]
    const first = setup({ items: [{ n: 1, ...cleanText('4 л') }] })
    const budget = new AiExecutionBudget(10_000)
    try {
      await processTextChunk(row, [item(1, 'a'), item(2, 'b')], true, first.model, first.gateway, budget)
      expect(first.sets).toEqual([])
      expect(states()).toEqual(expect.arrayContaining([[id(1), 'sample', null], [id(2), 'pending', 'помічник не дав тексту']]))
      sql.calls.length = 0; sql.attempts = 3
      await processTextChunk(row, [item(2, 'b')], true, setup({ items: [] }).model, first.gateway, budget)
      expect(states()).toEqual([[id(2), 'failed', 'помічник не дав тексту']])
    } finally { budget.dispose() }
  })
})
