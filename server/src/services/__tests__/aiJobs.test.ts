import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../db/pg.js', () => ({ pool: { query } }))
import { AiExecutionBudget } from '../aiExecutionBudget.js'
import { JOB_CHUNK, JOB_PARALLEL, estimateJob, jobSystemPrompt, judgeName, parseJobReply, processChunk, usageCostUsd } from '../aiJobService.js'
import { appendReply, cleanChatState, CHAT_MAX_ENTRIES } from '../aiChatStore.js'

// 26.11.2026, слово власника: «помічник бере по 200 товарів і робить це дуже довго; товарів мільйони; хай працює на
// сервері у фоні; на будь-якому пристрої однаковий чат». Перевіряємо головне: програма сама перевіряє кожну назву
// (модель не може вигадати число чи загубити артикул), збій пачки повертає її в чергу, а чат не задвоюється.
describe('background name job: the program checks every name itself', () => {
  const old = 'VALEO VL 700431 5 13348 40 Дросельна заслонка з електроприводом OPEL VIVARO A (X83) - 2.0 CDTI (F7) (2001.08 - 2014.07'

  it('cleanup may drop price-list codes (shown to the owner) but keeps the article and invents nothing', () => {
    const verdict = judgeName('cleanup', old, '700431', 'Дросельна заслонка з електроприводом OPEL VIVARO A VALEO 700431', '')
    expect(verdict.state).toBe('proposed')
    expect(verdict.note).toContain('прибрано: ')
    expect(verdict.note).toContain('13348')
  })

  it('an invented number or a lost article goes to «suspicious», not to the ready list', () => {
    expect(judgeName('cleanup', 'Фільтр масляний MANN W712/75', 'W712/75', 'Фільтр масляний MANN W712/75 1.6 л', '').state).toBe('suspicious')
    const lost = judgeName('cleanup', 'Фільтр масляний MANN W712/75', 'W712/75', 'Фільтр масляний MANN', '')
    expect(lost.state).toBe('suspicious')
    expect(lost.note).toContain('зник артикул W712/75')
  })

  it('translation never drops a code or number', () => {
    expect(judgeName('translate', 'Масло моторное 5W40 4л', null, 'Олива моторна 5W40 4л', '').state).toBe('proposed')
    const dropped = judgeName('translate', 'Масло моторное 5W40 4л', null, 'Олива моторна 5W40', '')
    expect(dropped.state).toBe('suspicious')
    expect(dropped.note).toContain('зникло: 4л')
  })

  it('the same name is «no change»; an article from the name only replaces an empty or AUTO- article and must be in the old name', () => {
    expect(judgeName('cleanup', 'Свічка NGK BKR6E', null, ' Свічка  NGK BKR6E ', '').state).toBe('unchanged')
    expect(judgeName('cleanup', 'NGK BKR6E свічка запалювання', 'AUTO-000123', 'Свічка запалювання NGK BKR6E', 'BKR6E').sku).toBe('BKR6E')
    expect(judgeName('cleanup', 'NGK BKR6E свічка запалювання', 'BKR6E', 'Свічка запалювання NGK BKR6E', 'BKR6E').sku).toBeNull()
    expect(judgeName('cleanup', 'NGK BKR6E свічка запалювання', null, 'Свічка запалювання NGK BKR6E', 'ZZZ999').sku).toBeNull()
  })

  it('model reply: JSON (even in ```), only numbers from this batch, no duplicates', () => {
    const replies = parseJobReply('```json\n{"items":[{"n":1,"name":"A"},{"n":1,"name":"B"},{"n":7,"name":"X"},{"n":2,"name":"C","sku":"S"}]}\n```', new Set([1, 2]))
    expect([...replies.keys()]).toEqual([1, 2])
    expect(replies.get(1)?.name).toBe('A')
    expect(() => parseJobReply('вибачте, не можу', new Set([1]))).toThrow()
  })

  it('cost and time are estimated before the start; real cost counts cache and output', () => {
    expect(estimateJob(JOB_CHUNK * JOB_PARALLEL * 10)).toEqual({ cost_usd: Number((3200 * (40 * 2 + 350) / 1e6).toFixed(2)), minutes: 10 })
    expect(usageCostUsd({ promptTokens: 1_000_000, completionTokens: 100_000, costAdjustUsd: -0.5 })).toBeCloseTo(2 + 1 - 0.5)
    expect(jobSystemPrompt('translate')).toContain('Цифр не прибирай і не додавай')
    expect(jobSystemPrompt('cleanup')).toContain('Нічого НЕ вигадуй')
  })
})

describe('background name job: one batch', () => {
  beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [], rowCount: 1 }) })
  const items = [
    { item_key: 'p1', seq: 1, old_name: 'Масло моторное 5W40 4л', sku: null },
    { item_key: 'p2', seq: 2, old_name: 'Свічка NGK BKR6E', sku: 'BKR6E' },
  ]

  it('writes each verdict; items the model skipped are «no change»', async () => {
    const model = { complete: vi.fn(async () => ({ text: '{"items":[{"n":1,"name":"Олива моторна 5W40 4л"}]}', truncated: false, promptTokens: 1000, completionTokens: 200 })) }
    const budget = new AiExecutionBudget(10_000)
    const out = await processChunk({ id: 'job', task: 'translate' }, items, model, budget)
    budget.dispose()
    expect(out.cost).toBeCloseTo(1000 * 2 / 1e6 + 200 * 10 / 1e6)
    const writes = query.mock.calls.filter(call => String(call[0]).startsWith('UPDATE ai_job_items SET state = $3'))
    expect(writes.map(call => [call[1][1], call[1][2], call[1][3]])).toEqual([['p1', 'proposed', 'Олива моторна 5W40 4л'], ['p2', 'unchanged', null]])
    expect(model.complete.mock.calls[0][1].text).toBe('№1\t-\tМасло моторное 5W40 4л\n№2\tBKR6E\tСвічка NGK BKR6E')
  })

  it('a failed or cut-off model answer returns the whole batch to the queue', async () => {
    const model = { complete: vi.fn(async () => ({ text: '{"items":[', truncated: true, promptTokens: 1, completionTokens: 1 })) }
    const budget = new AiExecutionBudget(10_000)
    await expect(processChunk({ id: 'job', task: 'cleanup' }, items, model, budget)).rejects.toThrow()
    budget.dispose()
    const back = query.mock.calls.find(call => String(call[0]).includes("SET state = 'pending'"))
    expect(back?.[1]).toEqual(['job', ['p1', 'p2']])
  })

  it('wiring: cron every minute, chat tool prepares (never starts) a job, supplier names go to custom_name only', () => {
    const migration = readFileSync(new URL('../../../../supabase/migrations/20261126090000_ai_jobs_site_catalog.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    expect(migration).toContain("'forsage-ai-jobs',\n  '* * * * *'")
    expect(migration).toContain('/api/v1/internal/ai-jobs')
    expect(migration).toContain('COALESCE(o.custom_name, o.name) AS name')
    expect(migration).toContain('WHERE o.total_qty > 0 AND NOT o.hidden')
    const service = readFileSync(new URL('../aiJobService.ts', import.meta.url), 'utf8')
    expect(service).toContain('UPDATE supplier_offers o SET custom_name = left(p.new_name, 400)')
    expect(service).not.toMatch(/UPDATE products/)
    const chat = readFileSync(new URL('../aiService.ts', import.meta.url), 'utf8')
    expect(chat).toContain("name: 'prepare_bulk_job'")
    expect(chat).toContain("if (!['owner', 'admin'].includes(String(params.role ?? ''))) return")
    // 26.11.2026 (власник: «дав завдання — 5 хв 0%»): задачу, яку власник попросив у чаті, чат запускає сам;
    // застосувати назви до карток — і далі лише кнопкою власника (чат цього не робить).
    expect(chat).toContain("changeJobStatus(tenantId, job.id, 'start')")
    expect(chat).not.toMatch(/applyOfferItems|markProductItems/)
  })
})

describe('shared assistant chat', () => {
  it('keeps only real replies, at most the last 80', () => {
    const state = cleanChatState({ entries: [{ role: 'user', text: 'a' }, { role: 'system', text: 'x' }, { role: 'model' }, ...Array.from({ length: 100 }, (_, i) => ({ role: 'model', text: String(i) }))], savedAt: '5' })
    expect(state.entries).toHaveLength(CHAT_MAX_ENTRIES)
    expect(state.entries?.[0].text).toBe('20')
    expect(state.savedAt).toBe(5)
  })

  it('a reply finished after the phone was closed is added once, with its question; repeats add nothing', () => {
    const first = appendReply({ entries: [{ role: 'user', text: 'привіт', rid: 'r1' }], savedAt: 10 }, 'r1', 'привіт', { text: 'Вітаю', actions: [], cost: 0.01 }, 100)
    expect(first?.entries).toEqual([{ role: 'user', text: 'привіт', rid: 'r1' }, { text: 'Вітаю', actions: [], cost: 0.01, role: 'model', rid: 'r1' }])
    expect(first?.savedAt).toBe(100)
    expect(appendReply(first, 'r1', 'привіт', { text: 'Вітаю' })).toBeNull()
    const fresh = appendReply(null, 'r2', 'наведи порядок', { text: 'Задачу підготовлено' }, 5)
    expect(fresh?.entries?.map(entry => entry.role)).toEqual(['user', 'model'])
  })
})
