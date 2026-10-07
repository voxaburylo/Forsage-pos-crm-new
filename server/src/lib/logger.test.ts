import { beforeEach, describe, expect, it, vi } from 'vitest'
const capture = vi.hoisted(() => ({ lines: [] as string[] }))
vi.mock('pino', async original => {
  const pino = await original<typeof import('pino')>()
  return { ...pino, default: (options: import('pino').LoggerOptions) => pino.default(
    { ...options, transport: undefined, base: undefined },
    { write: (line: string) => { capture.lines.push(line) } },
  ) }
})
import { logger } from './logger.js'
const last = () => JSON.parse(capture.lines.at(-1)!)
beforeEach(() => { capture.lines.length = 0 })

describe('actual application logger privacy boundary', () => {
  it.each(['info', 'warn', 'error', 'fatal'] as const)('%s drops arbitrary private payloads before serialization', level => {
    logger[level]({ payload: { image: 'PRIVATE_PHOTO', password: 'PRIVATE_KEY' }, text: 'PRIVATE_TEXT',
      geminiRawResponse: 'PRIVATE_OCR', transcript: 'PRIVATE_VOICE', url: 'https://secret/PRIVATE_TOKEN',
      phone: '+380501234567', vin: 'PRIVATE_VIN', sku: 'PRIVATE_SKU', amount: 123, count: 4 }, 'Processing failed')
    expect(capture.lines.join('')).not.toMatch(/PRIVATE_|\+380501234567|https:\/\/secret/)
    expect(last()).toMatchObject({ msg: 'Processing failed', amount: 123, count: 4 })
  })
  it.each(['err', 'error', 'reason', 'cancelError'])('sanitizes %s, including nested causes and provider fields', key => {
    const error = new Error('PRIVATE_MESSAGE') as Error & { response: unknown; cause: unknown }
    error.stack = 'PRIVATE_STACK'
    error.cause = new Error('PRIVATE_CAUSE')
    error.response = { headers: { authorization: 'PRIVATE_BEARER' } }
    logger.error({ [key]: error }, 'Request failed')
    expect(capture.lines.join('')).not.toContain('PRIVATE_')
    expect(last()[key]).toMatchObject({ error_type: 'Error', fingerprint: expect.stringMatching(/^[a-f0-9]{20}$/) })
  })
  it('prevents Pino from deriving its default message from a raw Error', () => {
    logger.error(new Error('PRIVATE_TOP_LEVEL'))
    expect(capture.lines.join('')).not.toContain('PRIVATE_')
    expect(last().error).toHaveProperty('fingerprint')
  })
  it('does not interpolate arbitrary values into static messages', () => {
    logger.warn('Request failed: %s', 'PRIVATE_INTERPOLATION')
    logger.warn({ count: 2 }, 'Failed: %o', { secret: 'PRIVATE_INTERPOLATION' })
    expect(capture.lines.join('')).not.toContain('PRIVATE_')
  })
  it('keeps only bounded safe metrics, statuses and correlation fingerprints', () => {
    logger.info({ count: 2, responseChars: 42, isFatal: false, status: 'pending',
      model: 'gemini-2.5-flash', finishReason: 'MAX_TOKENS',
      jobId: 'PRIVATE_JOB', userId: 'PRIVATE_USER', jobType: 'PRIVATE_JOB_TYPE',
      duration_ms: Infinity, amount: NaN, arbitrary: { secret: 'PRIVATE_OTHER' } }, 'Finished')
    const result = last()
    expect(result).toMatchObject({ count: 2, responseChars: 42, isFatal: false, status: 'pending',
      model: 'gemini-2.5-flash', finishReason: 'MAX_TOKENS', jobId_fingerprint: expect.any(String) })
    expect(result.duration_ms).toBeUndefined()
    expect(result.amount).toBeUndefined()
    expect(capture.lines.join('')).not.toContain('PRIVATE_')
  })
  it('sanitizes child bindings and does not mutate the input', () => {
    const input = { jobId: 'PRIVATE_JOB', token: 'PRIVATE_TOKEN', payload: { message: 'PRIVATE_CONTENT' } }
    const child = logger.child(input)
    child.info({ count: 1 }, 'Child task finished')
    expect(capture.lines.join('')).not.toContain('PRIVATE_')
    expect(last()).toMatchObject({ count: 1, jobId_fingerprint: expect.any(String) })
    expect(input).toEqual({ jobId: 'PRIVATE_JOB', token: 'PRIVATE_TOKEN', payload: { message: 'PRIVATE_CONTENT' } })
  })
  it('does not execute getters or toJSON from arbitrary log payloads', () => {
    const getter = vi.fn(() => { throw new Error('PRIVATE_GETTER') })
    const toJSON = vi.fn(() => { throw new Error('PRIVATE_TO_JSON') })
    const value = Object.defineProperty({ count: 3, toJSON }, 'payload', { get: getter, enumerable: true })
    expect(() => logger.error(value, 'Failure')).not.toThrow()
    expect(getter).not.toHaveBeenCalled()
    expect(toJSON).not.toHaveBeenCalled()
    expect(last().count).toBe(3)
  })
  it('does not let cycles, BigInt or hostile proxies break a business operation', () => {
    const cyclic: Record<string, unknown> = { count: 1, payload: 12n }
    cyclic.error = cyclic
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('PRIVATE_PROXY') }, get: () => { throw new Error('PRIVATE_GETTER') } })
    expect(() => logger.error(cyclic, 'Cyclic failure')).not.toThrow()
    expect(() => logger.error(hostile, 'Unreadable failure')).not.toThrow()
    expect(capture.lines.join('')).not.toContain('PRIVATE_')
    expect(capture.lines.every(line => line.length < 4000)).toBe(true)
  })
  it('sanitizes late bindings and descendants without invoking accessors', () => {
    const getter = vi.fn(() => 'PRIVATE_GETTER')
    const bindings = Object.defineProperty({ jobId: 'PRIVATE_JOB' }, 'token', { get: getter })
    const child = logger.child(bindings).child({ userId: 'PRIVATE_USER' })
    child.setBindings({ payload: 'PRIVATE_PAYLOAD', tenantId: 'PRIVATE_TENANT' })
    child.warn({}, 'Late binding')
    expect(capture.lines.join('')).not.toContain('PRIVATE_')
    expect(getter).not.toHaveBeenCalled()
    expect(last()).toHaveProperty('tenantId_fingerprint')
  })
  it('keeps repeated error fingerprints stable', () => {
    const error = new Error('PRIVATE_REPEATED')
    logger.error({ error }, 'Same failure')
    const first = last().error
    logger.error({ error }, 'Same failure')
    expect(last().error).toEqual(first)
    expect(first.fingerprint).toMatch(/^[a-f0-9]{20}$/)
  })
})
