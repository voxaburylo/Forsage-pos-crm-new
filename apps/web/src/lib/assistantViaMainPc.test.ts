import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ desktop: true, assistant: null as null | ((input: { method: string; path: string; body?: string }) => Promise<unknown>) }))
vi.mock('./desktopBridge', () => ({
  isDesktopRuntime: () => state.desktop,
  desktopBridge: () => (state.assistant ? { link: { assistant: state.assistant } } : { link: {} }),
}))
import { assistantThroughMainPc, isAssistantPath, uploadThroughMainPc } from './assistantViaMainPc'

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// 24.11.2026 (власник: «прибери пароль у ШІ-помічнику»): на головному ПК помічник ходить ключем ПК, без другого пароля.
describe('assistant through the main PC key', () => {
  beforeEach(() => { state.desktop = true; state.assistant = null })

  it('covers assistant and VIN addresses only; the AI key stays with the owner sign-in', () => {
    for (const path of ['/api/v1/ai/chat', '/api/v1/ai/status', '/api/v1/ai/memory/1', '/api/v1/vin/ocr', '/api/v1/ai/nbu-rate?currency=USD']) expect(isAssistantPath(path)).toBe(true)
    for (const path of ['/api/v1/ai/config', '/api/v1/ai/test', '/api/v1/sync/push', '/api/v1/products', '/api/v1/admin/users']) expect(isAssistantPath(path)).toBe(false)
  })

  it('returns the server answer as an ordinary response, errors included', async () => {
    const calls: unknown[] = []
    state.assistant = async input => { calls.push(input); return { status: 200, content_type: 'application/json', text: '{"data":{"enabled":true}}' } }
    const response = await assistantThroughMainPc('/api/v1/ai/status', undefined, undefined)
    expect(calls).toEqual([{ method: 'GET', path: '/ai/status', body: undefined }])
    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({ data: { enabled: true } })
    state.assistant = async () => ({ status: 403, content_type: 'application/json', text: '{"error":{"code":"FORBIDDEN","message":"ні"}}' })
    const denied = await assistantThroughMainPc('/api/v1/ai/chat', 'post', '{"messages":[]}')
    expect(denied?.status).toBe(403)
  })

  it('steps aside when this is not the main PC with a key: web, manager PC, no key, a failed call, another section', async () => {
    expect(await assistantThroughMainPc('/api/v1/ai/status', 'GET', undefined)).toBeNull()
    state.assistant = async () => null
    expect(await assistantThroughMainPc('/api/v1/ai/status', 'GET', undefined)).toBeNull()
    state.assistant = async () => { throw new Error('offline') }
    expect(await assistantThroughMainPc('/api/v1/ai/status', 'GET', undefined)).toBeNull()
    const spy = vi.fn(async () => ({ status: 200, content_type: 'application/json', text: '{}' }))
    state.assistant = spy
    expect(await assistantThroughMainPc('/api/v1/products', 'GET', undefined)).toBeNull()
    expect(await assistantThroughMainPc('/api/v1/ai/config', 'POST', '{}')).toBeNull()
    state.desktop = false
    expect(await assistantThroughMainPc('/api/v1/ai/status', 'GET', undefined)).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('an attachment goes through the main PC as text and comes back as a stored path', async () => {
    const calls: Array<{ method: string; path: string; body?: string }> = []
    state.assistant = async input => { calls.push(input); return { status: 200, content_type: 'application/json', text: '{"data":{"path":"u/ai/f.jpg","mimeType":"image/jpeg"}}' } }
    const stored = await uploadThroughMainPc(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), 'ai', 'image/jpeg')
    expect(stored).toEqual({ path: 'u/ai/f.jpg', mimeType: 'image/jpeg' })
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/assistant-upload' })
    expect(JSON.parse(calls[0].body!)).toEqual({ purpose: 'ai', mime_type: 'image/jpeg', data_base64: 'AQID' })
    // Імпорт прайсу постачальника цим шляхом не ходить; відхилений ключ повертає на звичайний шлях.
    expect(await uploadThroughMainPc(new Blob(['x']), 'supplier-import', 'text/csv')).toBeNull()
    state.assistant = async () => ({ status: 401, content_type: 'application/json', text: '{"error":{"message":"ключ"}}' })
    expect(await uploadThroughMainPc(new Blob(['x'], { type: 'image/png' }), 'vin', 'image/png')).toBeNull()
    state.assistant = async () => ({ status: 413, content_type: 'application/json', text: '{"error":{"message":"Файл завеликий для обробки"}}' })
    await expect(uploadThroughMainPc(new Blob(['x'], { type: 'image/png' }), 'vin', 'image/png')).rejects.toThrow('Файл завеликий для обробки')
  })

  it('the request code tries the main PC before asking for a password', () => {
    const api = read('./api.ts')
    expect(api).toContain('const viaMainPcFirst = token ? null : await assistantThroughMainPc(path, fetchOptions.method, fetchOptions.body)')
    expect(api).toContain('const viaMainPc = viaMainPcFirst ? null : await assistantThroughMainPc(path, fetchOptions.method, fetchOptions.body)')
    const uploads = read('./processingUploads.ts')
    expect(uploads).toContain('const stored = await uploadThroughMainPc(blob, purpose, mimeType)')
  })
})
