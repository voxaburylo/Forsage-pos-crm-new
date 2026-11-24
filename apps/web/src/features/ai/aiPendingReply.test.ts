import { describe, expect, it } from 'vitest'
import {
  AI_PENDING_MAX_MS, clearPendingReply, isLostConnection, newAiRequestId, readPendingReply, waitForPendingReply, writePendingReply,
} from './aiPendingReply'

function memory() {
  const map = new Map<string, string>()
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v) }, removeItem: (k: string) => { map.delete(k) } }
}
const id = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('assistant reply survives a minimized browser or leaving the tab (24.11.2026)', () => {
  it('keeps the request number next to the chat until the reply is shown', () => {
    const storage = memory()
    writePendingReply('chat', storage, { id, message: 'наведи порядок', started_at: 1 })
    expect(readPendingReply('chat', storage)).toEqual({ id, message: 'наведи порядок', started_at: 1 })
    clearPendingReply('chat', storage, 'другий-номер')
    expect(readPendingReply('chat', storage)?.id).toBe(id)
    clearPendingReply('chat', storage, id)
    expect(readPendingReply('chat', storage)).toBeNull()
  })

  it('ignores a damaged record', () => {
    const storage = memory()
    storage.setItem('chat:pending', '{bad')
    expect(readPendingReply('chat', storage)).toBeNull()
    storage.setItem('chat:pending', JSON.stringify({ id: '../x', started_at: 1 }))
    expect(readPendingReply('chat', storage)).toBeNull()
  })

  it('a dropped connection is recoverable; a refusal by the server is shown at once', () => {
    expect(isLostConnection(new TypeError('Failed to fetch'))).toBe(true)
    expect(isLostConnection(new Error('Відповідь ШІ обірвалась.'))).toBe(true)
    expect(isLostConnection(Object.assign(new Error('Ліміт'), { status: 429 }))).toBe(false)
    expect(isLostConnection(Object.assign(new Error('wrapped'), { cause: Object.assign(new Error('Ключ'), { status: 401 }) }))).toBe(false)
    expect(isLostConnection(Object.assign(new Error('wrapped'), { cause: new TypeError('network') }))).toBe(true)
  })

  it('makes a lowercase UUID the server accepts, even without randomUUID', () => {
    expect(newAiRequestId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(newAiRequestId(() => id.toUpperCase())).toBe(id)
  })

  it('waits until the server has the reply, then returns it', async () => {
    let calls = 0
    const outcome = await waitForPendingReply({ id, message: 'm', started_at: 0 }, {
      fetchResult: async () => (++calls < 3 ? null : { data: { reply: 'готово', actions: [{ id: 'a' }], usage: { cost_usd: 0.1 } } }),
      shouldStop: () => false, now: () => 1000, sleep: async () => {},
    })
    expect(calls).toBe(3)
    expect(outcome).toEqual({ kind: 'reply', data: { reply: 'готово', actions: [{ id: 'a' }], usage: { cost_usd: 0.1 } } })
  })

  it('reports the server error, a network blip is retried', async () => {
    let calls = 0
    const outcome = await waitForPendingReply({ id, message: 'm', started_at: 0 }, {
      fetchResult: async () => { calls++; if (calls === 1) throw new Error('offline'); return { error: { message: 'Ліміт витрат' } } },
      shouldStop: () => false, now: () => 0, sleep: async () => {},
    })
    expect(outcome).toEqual({ kind: 'error', message: 'Ліміт витрат' })
  })

  it('gives up after the time limit, and stops when the screen closes', async () => {
    expect(await waitForPendingReply({ id, message: 'm', started_at: 0 }, {
      fetchResult: async () => null, shouldStop: () => false, now: () => AI_PENDING_MAX_MS + 1, sleep: async () => {},
    })).toEqual({ kind: 'expired' })
    expect(await waitForPendingReply({ id, message: 'm', started_at: 0 }, {
      fetchResult: async () => null, shouldStop: () => true, now: () => 0, sleep: async () => {},
    })).toEqual({ kind: 'stopped' })
  })
})
