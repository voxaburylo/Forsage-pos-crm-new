import { beforeEach, describe, expect, it, vi } from 'vitest'

// 26.11.2026, власник: «підключи Haiku 5.5, щоб Sonnet 5.5 працював з ним у парі — кожен робить те, в чому сильний».
const sql = vi.hoisted(() => ({ calls: [] as Array<{ text: string; params: any[] }>, facts: [] as any[] }))
vi.mock('../db/pg.js', () => ({ pool: { query: async (text: string, params: any[] = []) => {
  sql.calls.push({ text, params })
  if (/FROM products p LEFT JOIN brands/.test(text)) return { rows: sql.facts }
  if (/SELECT attempts FROM site_text_items/.test(text)) return { rows: [{ attempts: 1 }] }
  return { rows: [], rowCount: 0 }
} } }))
import { claudeUsageFrom, helperRebateUsd, helperWithFallback, HELPER_MODEL, type CompleteModel } from './aiClaude.js'
import { AiExecutionBudget } from './aiExecutionBudget.js'
import { usageCostUsd } from './aiJobService.js'
import { AppError } from '../middleware/errorHandler.js'
import { checkLine, checkPrompt, parseCheckReply } from './siteTextCheck.js'
import { processTextChunk, type TextGateway, type TextModel } from './siteTextJobService.js'

describe('the helper model costs what it really costs', () => {
  it('a Haiku request is 20 times cheaper than the same on Sonnet; tokens stay honest', () => {
    const usage = claudeUsageFrom({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, HELPER_MODEL)
    expect(usage.promptTokens).toBe(1_000_000)
    expect(usageCostUsd(usage)).toBeCloseTo(0.10 + 0.50, 6)
    expect(usageCostUsd(claudeUsageFrom({ input_tokens: 1_000_000, output_tokens: 1_000_000 }))).toBeCloseTo(12, 6)
    expect(helperRebateUsd('claude-sonnet-5-5', 5000, 5000)).toBe(0)
  })
})

describe('the helper never stops the work', () => {
  const answer = (text: string) => ({ text, truncated: false, promptTokens: 1, completionTokens: 1 })
  const budget = () => new AiExecutionBudget(5_000)

  it('Haiku unavailable — the main model answers the same question', async () => {
    const helper: CompleteModel = { complete: vi.fn(async () => { throw new AppError('AI_KEY_INVALID', 'no access', 400) }) }
    const main: CompleteModel = { complete: vi.fn(async () => answer('main s')) }
    const b = budget()
    try { expect((await helperWithFallback(helper, main).complete(b, { system: 's', text: 't' })).text).toBe('main s') } finally { b.dispose() }
    expect(main.complete).toHaveBeenCalledTimes(1)
  })

  it('an empty account is not hidden by the fallback', async () => {
    const helper: CompleteModel = { complete: vi.fn(async () => { throw new AppError('AI_QUOTA_EXCEEDED', 'no money', 429) }) }
    const main: CompleteModel = { complete: vi.fn(async () => answer('main')) }
    const b = budget()
    try { await expect(helperWithFallback(helper, main).complete(b, { system: 's', text: 't' })).rejects.toMatchObject({ code: 'AI_QUOTA_EXCEEDED' }) } finally { b.dispose() }
    expect(main.complete).not.toHaveBeenCalled()
  })
})

describe('second check of product texts', () => {
  it('only a clear «not ok» for a known product counts; a broken answer blocks nobody', () => {
    const known = new Set([1, 2, 3])
    const reply = 'ось: {"items":[{"n":1,"ok":true},{"n":2,"ok":false,"why":"у даних немає  моделі авто  Opel s"},{"n":9,"ok":false,"why":"x"},{"n":3,"ok":"false"}]}'
    expect([...parseCheckReply(reply, known)]).toEqual([[2, 'у даних немає моделі авто Opel s']])
    expect(parseCheckReply('не JSON', known).size).toBe(0)
    expect(parseCheckReply('{"items":[{"n":1,"ok":false}]}', known).get(1)).toBe('текст викликав сумнів')
  })

  it('the checker sees the product data next to the texts', () => {
    const line = checkLine(7, { name: 'Фільтр масляний s', sku: 'W712', brand: 'MANN', category: null, unit: 'шт', oem: null, specs: {}, crosses: [] },
      { description: 'Опис', seo_title: 'Заголовок', seo_description: 'Мета', seo_keywords: 'фільтр, MANN' })
    expect(line).toMatch(/ДАНІ: №7 \| назва: Фільтр масляний s \| артикул: W712/)
    expect(line).toMatch(/ключові слова: фільтр, MANN/)
    expect(checkPrompt()).toMatch(/Коли сумніваєшся — став «ok»: true/)
  })

  const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
  const text = (volume: string) => ({
    description: `Моторна олива Castrol Magnatec 5W-40 у каністрі ${volume}. Підходить для двигунів, де виробник авто вимагає вʼязкість 5W-40. Перед купівлею звірте вʼязкість із сервісною книжкою вашого авто, щоб не помилитися.`,
    seo_title: `Олива Castrol Magnatec 5W-40 ${volume} — моторна`,
    seo_description: `Моторна олива Castrol Magnatec 5W-40, каністра ${volume}. Замовляйте з доставкою по Україні, підберемо під ваше авто.`,
  })
  beforeEach(() => { sql.calls.length = 0 })

  it('Sonnet writes, Haiku doubts one text: it is held for the owner, the other goes to the site', async () => {
    sql.facts = [1, 2].map(n => ({ id: id(n), name: `Олива моторна Castrol Magnatec 5W-40 ${n === 1 ? 4 : 1}л s`, sku: '15C9D' + n, unit: 'шт', oem_number: '', specs: {}, brand: 'Castrol', category: 'Моторні оливи', crosses: null }))
    const sets: Array<Record<string, unknown>> = []
    const gateway: TextGateway = vi.fn(async (_user, action, params) => {
      if (action === 'products.site_fields.get') return { description: '', hidden: false }
      sets.push(...(params.items as Array<Record<string, unknown>>)); return { saved: 1, not_on_site: [] }
    })
    const writer: TextModel = { complete: vi.fn(async () => ({ text: JSON.stringify({ items: [{ n: 1, ...text('4 л') }, { n: 2, ...text('1 л') }] }), truncated: false, promptTokens: 100, completionTokens: 200 })) }
    const checker: TextModel = { complete: vi.fn(async () => ({ text: '{"items":[{"n":1,"ok":true},{"n":2,"ok":false,"why":"сумнівна сумісність"}]}', truncated: false, promptTokens: 50, completionTokens: 10, costAdjustUsd: -0.001 })) }
    const item = (n: number) => ({ product_id: id(n), seq: n, name: 'x', state: 'working', new_fields: null, old_fields: null })
    const budget = new AiExecutionBudget(10_000)
    let usage
    try { usage = await processTextChunk({ id: 'job', tenant_id: 'shop', created_by: 'owner', overwrite: false, style_note: null }, [item(1), item(2)], false, writer, gateway, budget, checker) } finally { budget.dispose() }
    expect(sets.map(row => row.program_product_id)).toEqual([id(1)])
    const states = Object.fromEntries(sql.calls.filter(call => /UPDATE site_text_items SET state = \$3/.test(call.text)).map(call => [call.params[1], [call.params[2], call.params[3]]]))
    expect(states[id(2)]).toEqual(['review', 'друга перевірка: сумнівна сумісність'])
    expect(states[id(1)]).toEqual(['written', null])
    // Витрати обох моделей складаються в одну суму задачі.
    expect(usage).toEqual({ promptTokens: 150, completionTokens: 210, costAdjustUsd: -0.001 })
  })
})
