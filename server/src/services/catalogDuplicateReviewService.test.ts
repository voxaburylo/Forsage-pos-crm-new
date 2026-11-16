import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ generate: vi.fn(), config: vi.fn(), usage: vi.fn() }))
vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {}
  class Anthropic {
    static APIError = APIError
    static AuthenticationError = class extends APIError {}
    static PermissionDeniedError = class extends APIError {}
    static RateLimitError = class extends APIError {}
    static BadRequestError = class extends APIError {}
    beta = { messages: { stream: (body: any, options: any) => ({ finalMessage: () => mocks.generate(body, options) }) } }
  }
  return { default: Anthropic }
})
vi.mock('./aiService.js', () => ({ getAiConfig: mocks.config, recordAiUsage: mocks.usage }))
import { duplicateReviewSchema, reviewCatalogDuplicates, validateDuplicateReviews } from './catalogDuplicateReviewService.js'
const input = { groups: [{ id: 'group-1', products: [1, 2].map(n => ({ id: `00000000-0000-4000-8000-00000000000${n}`,
  name: 'Груша Balaton 10мм Г-подібна', sku: '', barcode: null, brand: 'Balaton', unit: 'шт' })) }] }
const json = { reviews: [{ group_id: 'group-1', verdict: 'same', reason: 'Збіг бренду, розміру й форми; підтверджує власник.' }] }
const response = (text = JSON.stringify(json), stop = 'end_turn') => ({ content: [{ type: 'text', text }], stop_reason: stop, usage: { input_tokens: 2, output_tokens: 3 } })
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); mocks.config.mockResolvedValue({ enabled: true, apiKey: 'fixture', model: 'claude-sonnet-5-5' }); mocks.generate.mockResolvedValue(response()) })
afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.useRealTimers() })
it('returns advice only with exact requested IDs and no write tools', async () => {
  expect(await reviewCatalogDuplicates('tenant', 'actor', input)).toEqual(json)
  expect(mocks.generate.mock.calls[0][0].tools).toBeUndefined()
  expect(mocks.generate.mock.calls[0][0].system).toContain('полярність')
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
  mocks.generate.mockResolvedValue(response(JSON.stringify(json), 'max_tokens'))
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
  expect(error.code).toBe('AI_UPSTREAM_UNAVAILABLE'); expect(error.message).not.toContain('API_KEY_PRIVATE')
})
it('cancels at the budget boundary', async () => {
  mocks.generate.mockImplementation(() => new Promise(() => {}))
  const pending = expect(reviewCatalogDuplicates('tenant', 'actor', input)).rejects.toMatchObject({ code: 'AI_TIMEOUT' })
  await vi.advanceTimersByTimeAsync(90_000); await pending
})
