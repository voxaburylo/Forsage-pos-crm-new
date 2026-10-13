import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ model: vi.fn(), generate: vi.fn(), config: vi.fn(), usage: vi.fn() }))
vi.mock('@google/generative-ai', () => ({ SchemaType: { OBJECT: 'OBJECT', ARRAY: 'ARRAY', STRING: 'STRING' },
  GoogleGenerativeAI: class { getGenerativeModel(options: unknown) { mocks.model(options); return { generateContent: mocks.generate } } },
}))
vi.mock('./aiService.js', () => ({ getAiConfig: mocks.config, recordAiUsage: mocks.usage }))
import { duplicateReviewSchema, reviewCatalogDuplicates, validateDuplicateReviews } from './catalogDuplicateReviewService.js'
const input = { groups: [{ id: 'group-1', products: [1, 2].map(n => ({ id: `00000000-0000-4000-8000-00000000000${n}`,
  name: 'Груша Balaton 10мм Г-подібна', sku: '', barcode: null, brand: 'Balaton', unit: 'шт' })) }] }
const json = { reviews: [{ group_id: 'group-1', verdict: 'same', reason: 'Збіг бренду, розміру й форми; підтверджує власник.' }] }
const response = (text = JSON.stringify(json), finishReason = 'STOP') => ({ response: {
  text: () => text, candidates: [{ finishReason }], usageMetadata: { promptTokenCount: 2, totalTokenCount: 5 },
} })
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); mocks.config.mockResolvedValue({ enabled: true, apiKey: 'fixture', model: 'fixture' }); mocks.generate.mockResolvedValue(response()) })
afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.useRealTimers() })
it('returns advice only with exact requested IDs and no write tools', async () => {
  expect(await reviewCatalogDuplicates('tenant', 'actor', input)).toEqual(json)
  expect(mocks.model.mock.calls[0][0].tools).toBeUndefined()
  expect(mocks.model.mock.calls[0][0].systemInstruction).toContain('полярність')
  expect(mocks.usage).toHaveBeenCalledOnce()
})
it.each([[], [json.reviews[0], json.reviews[0]], [{ ...json.reviews[0], group_id: 'unknown' }]])('rejects incomplete/repeated/foreign reviews', reviews => {
  expect(() => validateDuplicateReviews({ reviews }, input)).toThrow()
})
it('rejects unknown write fields and ambiguous request IDs', () => {
  expect(() => validateDuplicateReviews({ reviews: [{ ...json.reviews[0], quantity: 10 }] }, input)).toThrow()
  expect(duplicateReviewSchema.safeParse({ groups: [input.groups[0], input.groups[0]] }).success).toBe(false)
})
it('rejects truncated response even when JSON parses', async () => {
  mocks.generate.mockResolvedValue(response(JSON.stringify(json), 'MAX_TOKENS'))
  await expect(reviewCatalogDuplicates('tenant', 'actor', input)).rejects.toMatchObject({ status: 422 })
})
it.each(['{PRIVATE_SECRET', '[]'])('does not leak response excerpts', async raw => {
  mocks.generate.mockResolvedValue(response(raw))
  const error = await reviewCatalogDuplicates('tenant', 'actor', input).catch(e => e)
  expect(error.code).toBe('AI_REVIEW_INVALID'); expect(error.message).not.toContain('PRIVATE_SECRET')
})
it('does not leak provider errors', async () => {
  mocks.generate.mockRejectedValue(new Error('API_KEY_PRIVATE'))
  const error = await reviewCatalogDuplicates('tenant', 'actor', input).catch(e => e)
  expect(error.code).toBe('AI_REVIEW_FAILED'); expect(error.message).not.toContain('API_KEY_PRIVATE')
})
it('cancels at the budget boundary', async () => {
  mocks.generate.mockImplementation(() => new Promise(() => {}))
  const pending = expect(reviewCatalogDuplicates('tenant', 'actor', input)).rejects.toMatchObject({ code: 'AI_TIMEOUT' })
  await vi.advanceTimersByTimeAsync(90_000); await pending
})
