import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ from: vi.fn(), upload: vi.fn(), download: vi.fn(), list: vi.fn(), remove: vi.fn() }))
vi.mock('../db/supabase.js', () => ({ db: { storage: { from: mocks.from } } }))
import { aiReplyPath, isAiRequestId, pruneAiReplies, readAiReply, saveAiReply, AI_REPLY_TTL_MS } from './aiReplyStore.js'
import { AI_MEMORY_BUCKET } from './aiMemoryService.js'

const tenant = 'tenant-1', user = 'user-1', id = '0f8fad5b-d9cb-469f-a165-70867728950e'
beforeEach(() => {
  vi.resetAllMocks()
  mocks.from.mockReturnValue({ upload: mocks.upload, download: mocks.download, list: mocks.list, remove: mocks.remove })
  mocks.upload.mockResolvedValue({ error: null })
  mocks.list.mockResolvedValue({ data: [] })
  mocks.remove.mockResolvedValue({ error: null })
})

describe('assistant reply kept for a lost connection (24.11.2026)', () => {
  it('accepts only a lowercase UUID as the request number, so no path can be smuggled in', () => {
    expect(isAiRequestId(id)).toBe(true)
    for (const bad of ['../x', id.toUpperCase(), id + '/..', '', 'abc', null]) expect(isAiRequestId(bad)).toBe(false)
    expect(() => aiReplyPath(tenant, user, '../../rules')).toThrow()
  })

  it('stores the reply privately under the shop and the person who asked', async () => {
    expect(await saveAiReply(tenant, user, id, { data: { reply: 'ok' } })).toBe(true)
    expect(mocks.from).toHaveBeenCalledWith(AI_MEMORY_BUCKET)
    const [path, body, options] = mocks.upload.mock.calls[0]
    expect(path).toBe(`${tenant}/replies/${user}/${id}.json`)
    expect(JSON.parse(body)).toMatchObject({ data: { reply: 'ok' } })
    expect(options).toMatchObject({ contentType: 'application/json', upsert: true })
  })

  it('never throws when storage fails — the reply still goes to the open connection', async () => {
    mocks.upload.mockRejectedValue(new Error('down'))
    expect(await saveAiReply(tenant, user, id, { data: { reply: 'ok' } })).toBe(false)
  })

  it('reads the reply back, and null while it is not ready', async () => {
    mocks.download.mockResolvedValueOnce({ data: null, error: { message: 'not found' } })
    expect(await readAiReply(tenant, user, id)).toBeNull()
    mocks.download.mockResolvedValueOnce({ data: new Blob([JSON.stringify({ data: { reply: 'готово' }, saved_at: 'x' })]), error: null })
    expect(await readAiReply(tenant, user, id)).toMatchObject({ data: { reply: 'готово' } })
    expect(mocks.download).toHaveBeenLastCalledWith(`${tenant}/replies/${user}/${id}.json`)
  })

  it('removes replies older than a day', async () => {
    const now = Date.parse('2026-11-25T12:00:00Z')
    mocks.list.mockResolvedValue({ data: [
      { name: 'old.json', created_at: new Date(now - AI_REPLY_TTL_MS - 1000).toISOString() },
      { name: 'fresh.json', created_at: new Date(now - 1000).toISOString() },
    ] })
    await pruneAiReplies(tenant, user, now)
    expect(mocks.remove).toHaveBeenCalledWith([`${tenant}/replies/${user}/old.json`])
  })
})
