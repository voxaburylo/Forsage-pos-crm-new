import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ generate: vi.fn(), download: vi.fn(), remove: vi.fn(), warn: vi.fn(), usage: vi.fn() }))
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
vi.mock('../services/aiService.js', () => ({
  getAiConfig: async () => ({ enabled: true, apiKey: 'fixture-key', model: 'claude-sonnet-5-5', hasKey: true }),
  recordAiUsage: mocks.usage,
}))
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }))
vi.mock('../services/adminService.js', () => ({ getSettings: vi.fn() }))
vi.mock('../services/processingUploadService.js', () => ({ downloadProcessingUpload: mocks.download, removeProcessingUploads: mocks.remove }))
vi.mock('../lib/logger.js', () => ({ logger: { warn: mocks.warn } }))
import router from './vin.js'
import { AI_UNTRUSTED_DATA_RULES } from '../services/aiPromptSafety.js'
const handler = (router as any).stack.find((layer: any) => layer.route?.path === '/ocr').route.stack.at(-1).handle
const userId = '00000000-0000-4000-8000-000000000001'
const owned = userId + '/vin/00000000-0000-4000-8000-000000000002.png'
const vin = 'WVWZZZ1JZXW000001'
const response = (text = JSON.stringify({ vin }), stop = 'end_turn') => ({ content: [{ type: 'text', text }], stop_reason: stop, usage: { input_tokens: 2, output_tokens: 3 } })
const call = async (body: unknown) => {
  const res = { json: vi.fn() }, next = vi.fn()
  await handler({ body, user: { id: userId, tenant_id: 'shop' } }, res, next)
  return { data: res.json.mock.calls[0]?.[0]?.data, error: next.mock.calls[0]?.[0] }
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks()
  mocks.generate.mockResolvedValue(response())
  mocks.download.mockResolvedValue({ buffer: Buffer.from([0]), mimeType: 'image/png' })
  mocks.remove.mockResolvedValue(undefined)
})
afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.useRealTimers() })
describe('VIN route never trusts photo instructions or raw provider errors', () => {
  it('uses the shared boundary and reads/cleans only the explicit owned path', async () => {
    expect((await call({ storage_path: owned })).data).toMatchObject({ vin })
    expect(mocks.generate.mock.calls[0][0].system).toContain(AI_UNTRUSTED_DATA_RULES)
    expect(mocks.generate.mock.calls[0][0].tools).toBeUndefined()
    expect(mocks.usage).toHaveBeenCalledOnce()
    expect(mocks.download).toHaveBeenCalledWith(expect.objectContaining({ path: owned, userId, purpose: 'vin', maxBytes: 6 * 1024 * 1024 }))
    expect(mocks.remove).toHaveBeenCalledWith([owned], userId)
    expect(mocks.generate.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })
  it.each(['max_tokens', 'refusal'])('does not accept a VIN from %s output', async reason => {
    mocks.generate.mockResolvedValue(response(JSON.stringify({ vin }), reason))
    const result = await call({ storage_path: owned })
    expect(result.data).toBeUndefined()
    expect(result.error).toMatchObject({ status: 422 })
    expect(mocks.remove).toHaveBeenCalledWith([owned], userId)
  })
  it.each([
    { image: 'AA==', mimeType: 'text/html' }, { image: 'https://private.test/photo' },
    { storage_path: owned, image: 'AA==' }, { storage_path: owned, confirmed: true },
  ])('rejects invalid/ambiguous bodies before a provider call', async body => {
    expect((await call(body)).error).toMatchObject({ status: 422 })
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.download).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })
  it.each(['null', '{"vin":"WVWZZZ1JZXW000001",', '{"vin":"WVWZZZ1JZXW000001","tool":"delete_all"}'])('rejects malformed or extra action data: %s', async text => {
    mocks.generate.mockResolvedValue(response(text))
    expect((await call({ image: 'AA==' })).error).toMatchObject({ code: 'AI_VEHICLE_INVALID_RESPONSE', status: 422 })
  })
  it('replaces provider exceptions with a fixed message and private diagnostic', async () => {
    mocks.generate.mockRejectedValue(new Error('SECRET invoice phone Bearer secret-value'))
    const result = await call({ storage_path: owned })
    expect(result.error).toMatchObject({ code: 'AI_UPSTREAM_UNAVAILABLE', status: 503 })
    expect(result.error.message).not.toContain('SECRET')
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toMatch(/SECRET|Bearer|secret-value/)
  })
  it('bounds a stuck provider and still cleans the uploaded file', async () => {
    mocks.generate.mockReturnValue(new Promise(() => {}))
    const pending = call({ storage_path: owned })
    await vi.advanceTimersByTimeAsync(90_000)
    expect((await pending).error).toMatchObject({ code: 'AI_TIMEOUT', status: 504 })
    expect(mocks.remove).toHaveBeenCalledWith([owned], userId)
  })
})
