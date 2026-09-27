import { describe, expect, it } from 'vitest'
import { aiAvailabilityProblem } from './aiAvailability'
describe('AI availability error explanations', () => {
  it.each([
    [{ status: 401 }, 'session'], [{ code: 'DESKTOP_SERVER_AUTH_REQUIRED' }, 'session'],
    [Error('Серверна сесія ще не відновлена.'), 'session'], [{ status: 403 }, 'access'],
    [Error('Сервер недоступний.'), 'network'], [Error('Failed to fetch'), 'network'],
    [Error('Сервер не відповів вчасно.'), 'timeout'], [{ status: 500 }, 'server'],
    [{ code: 'PROCESSING_TIMEOUT', message: 'Завантаження триває надто довго' }, 'timeout'],
    [{ code: 'AI_TIMEOUT' }, 'timeout'], [{ status: 504 }, 'timeout'],
  ])('classifies %j without claiming every error is lost internet', (error, kind) => {
    expect(aiAvailabilityProblem(error).kind).toBe(kind)
  })
  it('preserves a session error wrapped by invoice recognition', () => {
    const wrapped = Object.assign(Error('Накладну не створено'), { cause: { status: 401 } })
    expect(aiAvailabilityProblem(wrapped).kind).toBe('session')
    wrapped.cause = wrapped as any
    expect(aiAvailabilityProblem(wrapped).kind).toBe('server')
  })
  it('never echoes a raw server response or secret', () => {
    expect(aiAvailabilityProblem(Error('private SQL password fixture')).message).not.toContain('private')
  })
})
