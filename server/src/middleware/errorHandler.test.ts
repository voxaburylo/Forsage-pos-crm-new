import type { Request, Response, NextFunction } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('../lib/logger.js', () => ({ logger: { error: mocks.error } }))
import { AppError, errorHandler } from './errorHandler.js'

function handle(error: unknown) {
  const json = vi.fn()
  const status = vi.fn().mockReturnValue({ json })
  errorHandler(error, {} as Request, { status } as unknown as Response, vi.fn() as NextFunction)
  return { status: status.mock.calls[0][0], body: json.mock.calls[0][0] }
}
beforeEach(() => vi.clearAllMocks())

describe('unhandled errors keep diagnostics but not private documents', () => {
  it.each([
    { headersSent: true, destroyed: false },
    { headersSent: true, destroyed: true },
    { headersSent: false, destroyed: true },
  ])('closes partial responses without appending private errors %#', state => {
    const res = { ...state, destroy: vi.fn(), status: vi.fn(), json: vi.fn() }
    errorHandler(new AppError('INTERNAL', 'PRIVATE_INVOICE', 500), {} as Request, res as unknown as Response, vi.fn())
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
    expect(res.destroy).toHaveBeenCalledTimes(state.destroyed ? 0 : 1)
    expect(mocks.error).toHaveBeenCalledOnce()
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain('PRIVATE_')
  })
  it('preserves intentional application validation errors', () => {
    expect(handle(new AppError('VALIDATION_ERROR', 'Невірна кількість', 422, { field: 'quantity' }))).toEqual({
      status: 422, body: { error: { code: 'VALIDATION_ERROR', message: 'Невірна кількість', status: 422, details: { field: 'quantity' } } },
    })
    expect(mocks.error).not.toHaveBeenCalled()
  })
  it('never logs provider messages, stacks, causes, response bodies or arbitrary error names', () => {
    const error = new Error('Bearer PRIVATE_TOKEN data:image/png;base64,PRIVATE_PHOTO') as Error & { response: unknown; cause: unknown }
    error.name = 'PRIVATE_CUSTOMER'
    error.stack = 'PRIVATE_STACK C:/Users/PrivateName/photo.png'
    error.response = { data: { customer: 'PRIVATE_INVOICE' } }
    error.cause = new Error('PRIVATE_CAUSE')
    expect(handle(error).status).toBe(500)
    const info = mocks.error.mock.calls[0][0]
    expect(info).toMatchObject({ error_type: 'Error', fingerprint: expect.stringMatching(/^[a-f0-9]{20}$/) })
    expect(JSON.stringify(mocks.error.mock.calls)).not.toMatch(/PRIVATE_|PrivateName|base64|Bearer/)
    expect(mocks.error).toHaveBeenCalledOnce()
  })
  it.each(['fetch failed', 'ENOTFOUND', 'ECONNREFUSED', 'network failed'])('keeps the 503 response for %s without logging the URL/key', text => {
    const result = handle(new Error(text + ' https://private.example/?token=PRIVATE_SECRET'))
    expect(result.status).toBe(503)
    expect(result.body.error.code).toBe('SERVICE_UNAVAILABLE')
    expect(mocks.error.mock.calls[0][0]).toMatchObject({ category: 'network' })
    expect(JSON.stringify(mocks.error.mock.calls)).not.toMatch(/private.example|PRIVATE_SECRET/)
  })
  it('records only a safe category/status for a non-Error rejection', () => {
    handle({ message: 'PRIVATE_DOCUMENT', status: 502, code: 'PRIVATE_CODE', response: { customer: 'PRIVATE_CUSTOMER' } })
    expect(mocks.error.mock.calls[0][0]).toMatchObject({ category: 'upstream', status: 502, error_type: 'Error' })
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain('PRIVATE_')
  })
  it('keeps a stable fingerprint without exposing the underlying strings', () => {
    const first = new Error('PRIVATE_A'); first.stack = 'PRIVATE_FIXED_STACK'
    handle(first)
    const info = mocks.error.mock.calls[0][0]
    handle(first)
    expect(mocks.error.mock.calls[1][0]).toEqual(info)
    const second = new Error('PRIVATE_B'); second.stack = first.stack
    handle(second)
    expect(mocks.error.mock.calls[2][0].fingerprint).not.toBe(info.fingerprint)
  })
})
