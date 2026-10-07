import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ model: vi.fn(), generate: vi.fn(), config: vi.fn(), usage: vi.fn() }))
vi.mock('@google/generative-ai', () => ({
  SchemaType: { OBJECT: 'OBJECT', ARRAY: 'ARRAY', STRING: 'STRING' },
  GoogleGenerativeAI: class { getGenerativeModel(options: unknown) { mocks.model(options); return { generateContent: mocks.generate } } },
}))
vi.mock('./aiService.js', () => ({ getAiConfig: mocks.config, recordAiUsage: mocks.usage }))
import { reviewCatalog } from './catalogAgentService.js'
import { AI_UNTRUSTED_DATA_RULES } from './aiPromptSafety.js'
const product = { id: '00000000-0000-4000-8000-000000000001', name: 'Фильтр W67/1', sku: 'W67/1', brand: '', category_id: null }
const input = { products: [product], categories: [] }
const json = JSON.stringify({ proposals: [{ id: product.id, name: 'Фільтр W67/1', sku: product.sku, category_id: null, reason: 'Переклад' }] })
const response = (text = json, finishReason = 'STOP') => ({ response: { text: () => text, candidates: [{ finishReason }], usageMetadata: { promptTokenCount: 2, totalTokenCount: 5 } } })
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks()
  mocks.config.mockResolvedValue({ enabled: true, apiKey: 'fixture-key', model: 'fixture-model' })
  mocks.generate.mockResolvedValue(response()); mocks.usage.mockResolvedValue(undefined)
})
afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.useRealTimers() })
describe('catalog responses remain untrusted and private', () => {
  it('applies the shared data boundary without adding model tools', async () => {
    const result = await reviewCatalog('shop', 'user', input)
    expect(result.proposals).toHaveLength(1)
    expect(mocks.model.mock.calls[0][0].systemInstruction).toContain(AI_UNTRUSTED_DATA_RULES)
    expect(mocks.model.mock.calls[0][0].tools).toBeUndefined()
    expect(JSON.parse(mocks.generate.mock.calls[0][0])).toEqual(input)
    expect(mocks.usage).toHaveBeenCalledOnce()
  })
  it.each(['MAX_TOKENS', 'SAFETY', 'OTHER', 'MALFORMED_FUNCTION_CALL'])('rejects complete-looking JSON with %s', async reason => {
    mocks.generate.mockResolvedValue(response(json, reason))
    await expect(reviewCatalog('shop', 'user', input)).rejects.toMatchObject({ status: 422 })
    expect(mocks.usage).toHaveBeenCalledOnce()
  })
  it.each([
    '{ "private customer invoice SECRET',
    JSON.stringify({ proposals: [{ ...product, brand: undefined, name: 'Фільтр W67/1', reason: 'okay', PRIVATE_SECRET_COLUMN: 'SECRET' }] }),
  ])('does not return syntax/schema excerpts to the UI', async text => {
    mocks.generate.mockResolvedValue(response(text))
    const error = await reviewCatalog('shop', 'user', input).catch(error => error)
    expect(error).toMatchObject({ code: 'AI_REVIEW_INVALID', status: 422 })
    expect(error.message).not.toMatch(/SECRET|private customer/)
  })
  it.each(['PRIVATE_CUSTOMER_380123456789', 'Bearer SECRET', 'Document № private invoice'])('does not relay raw provider exceptions: %s', async secret => {
    mocks.generate.mockRejectedValue(new Error(secret))
    const error = await reviewCatalog('shop', 'user', input).catch(error => error)
    expect(error.code).toBe('AI_REVIEW_FAILED')
    expect(error.message).not.toContain(secret)
  })
  it('keeps a useful locally-owned incomplete-batch explanation', async () => {
    mocks.generate.mockResolvedValue(response('{"proposals":[]}'))
    await expect(reviewCatalog('shop', 'user', input)).rejects.toThrow('неповну')
  })
  it('times out without accepting a late provider response', async () => {
    let resolve!: (value: unknown) => void
    mocks.generate.mockImplementation(() => new Promise(done => { resolve = done }))
    const pending = expect(reviewCatalog('shop', 'user', input)).rejects.toMatchObject({ code: 'AI_TIMEOUT', status: 504 })
    await vi.advanceTimersByTimeAsync(90_000); await pending
    resolve(response()); await vi.advanceTimersByTimeAsync(0)
    expect(mocks.usage).not.toHaveBeenCalled()
  })
})
