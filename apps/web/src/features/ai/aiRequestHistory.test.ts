import { describe, expect, it, vi } from 'vitest'
import { aiRequestHistory } from './aiRequestHistory'
import { aiChatStorageKey, readAiChat } from './aiChatStorage'
import { apiValidationError } from '@/lib/apiValidationError'
const { post } = vi.hoisted(() => ({ post: vi.fn(async () => ({ data: {} })) }))
vi.mock('@/lib/api', () => ({ api: { post } }))
vi.mock('./localAiAction', () => ({ applyLocalAiAction: vi.fn() }))
vi.mock('@/lib/desktopBridge', () => ({ isDesktopRuntime: () => true }))
import { aiApi, type AiChatMessage } from './aiApi'
const history = (length: number): AiChatMessage[] => Array.from({ length }, (_, index) => ({ role: index % 2 ? 'model' : 'user', text: `Повідомлення ${index}` }))

describe('AI request history independent from the local action journal', () => {
  it.each([40, 41, 56, 80, 1000])('fits %s saved messages into the server limit without mutating them', length => {
    const source = history(length), snapshot = JSON.stringify(source), request = aiRequestHistory(source)
    expect(request.length).toBeLessThanOrEqual(40)
    expect(request[0].role).toBe('user')
    expect(request.at(-1)).toEqual(source.at(-1))
    expect(JSON.stringify(source)).toBe(snapshot)
  })
  it('also limits restored conversations immediately after opening the assistant', () => {
    const key = aiChatStorageKey('cashier', 'shop', false), entries = history(56)
    const storage = { getItem: (requested: string) => requested === key ? JSON.stringify({ entries, applied: { invoice: 'ok' } }) : null } as Storage
    const saved = readAiChat(key, storage)
    expect(aiRequestHistory(saved.entries)).toHaveLength(40)
    expect(saved.entries).toHaveLength(56)
    expect(saved.applied.invoice).toBe('ok')
  })
  it('omits blank/invalid entries and never starts with an orphaned model answer', () => {
    expect(aiRequestHistory([{ role: 'model', text: 'old' }, { role: 'user', text: ' ' }, { role: 'user', text: 'new' }])).toEqual([{ role: 'user', text: 'new' }])
    expect(aiRequestHistory([{ role: 'model', text: 'old' }])).toEqual([])
  })
  it('bounds the actual API transport without altering the new invoice or image', async () => {
    const body = { message: 'Розбери всі 6 рядків', history: history(56), file_text: 'Сума 19 214,00', images: [{ mime_type: 'image/jpeg' as const, storage_path: 'user/ai/photo.jpg' }] }
    await aiApi.chat(body)
    const sent = (post.mock.calls.at(-1) as unknown[])[1] as typeof body
    expect(sent.history).toHaveLength(40)
    expect(sent.images).toEqual(body.images)
    expect(sent.file_text).toBe(body.file_text)
    expect(sent.message).toBe(body.message)
    expect(body.history).toHaveLength(56)
  })
  it.each(['history', 'images', 'message', 'file_text'])('explains invalid %s without exposing input values', field => {
    const message = apiValidationError('/api/v1/ai/chat', 'Невірні дані', 'VALIDATION_ERROR', { fieldErrors: { [field]: ['private-value'] } })
    expect(message).not.toBe('Невірні дані'); expect(message).not.toContain('private-value')
  })
  it('does not reword unrelated errors or malformed details', () => {
    expect(apiValidationError('/api/v1/pos', 'Original', 'VALIDATION_ERROR', { fieldErrors: { history: ['error'] } })).toBe('Original')
    expect(apiValidationError('/api/v1/ai/chat', 'Original', 'OTHER', null)).toBe('Original')
  })
})

// 26.11.2026: помічник тричі поспіль пропонував ті самі пари, у яких каса відмовила, бо не знав підсумку.
describe('the assistant is told how its earlier proposals ended', () => {
  it('adds what the till wrote and refused to the model turn only in the request; the screen text stays', async () => {
    const { aiRequestHistoryWithOutcomes } = await import('./aiRequestHistory')
    const entries = [
      { role: 'user' as const, text: 'найди дубли' },
      { role: 'model' as const, text: 'Підготував 3 пари.', actions: [{ id: 'a1', title: "Об'єднати дублі: 3 пар" }] },
      { role: 'user' as const, text: 'ще' },
      { role: 'model' as const, text: 'Ще одна.', actions: [{ id: 'a2', title: 'Назви: 5' }, { id: 'a3', title: 'Кроси' }] },
    ]
    const request = aiRequestHistoryWithOutcomes(entries, {
      applied: { a1: 'ok', a2: 'rejected' }, applyMsg: { a1: 'Об’єднано пар: 2, пропущено 1.' },
      applyErrors: { a1: [{ item: 'Ремінь BOSCH s', error: 'Є відкрита ревізія' }] },
    })
    expect(request[1].text).toContain('Підготував 3 пари.')
    expect(request[1].text).toContain('Об’єднано пар: 2, пропущено 1.')
    expect(request[1].text).toContain('Ремінь BOSCH s — Є відкрита ревізія')
    expect(request[3].text).toContain('«Назви: 5» власник відхилив')
    expect(request[3].text).toContain('«Кроси» власник ще не підтвердив')
    expect(entries[1].text).toBe('Підготував 3 пари.')
    expect(request[0]).toEqual({ role: 'user', text: 'найди дубли' })
  })
})
