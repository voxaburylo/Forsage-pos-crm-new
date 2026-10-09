import { afterEach, expect, it, vi } from 'vitest'
vi.mock('./desktopBridge', () => ({ isDesktopRuntime: () => false }))
vi.mock('./supabase', () => ({ supabase: { auth: {
  getSession: async () => ({ data: { session: { access_token: 'test-token' } } }),
} } }))
import { request } from './api'
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
const encoder = new TextEncoder()
const streamed = (pieces: string[], error = false) => new Response(new ReadableStream({
  start(controller) {
    for (const part of pieces) controller.enqueue(encoder.encode(part))
    if (error) controller.error(new Error('connection lost'))
    else controller.close()
  },
}), { headers: { 'content-type': 'application/json' } })
it('waits for and returns the entire streamed JSON envelope', async () => {
  const expected = { data: { cursor: 'now', products: [{ name: 'Товар 😀', qty: 2 }] } }
  vi.stubGlobal('fetch', vi.fn(async () => streamed(['{"data":{"cursor":"now",', '"products":[{"name":"Товар 😀","qty":2}]}}'])))
  expect(await request('/api/v1/sync/changes', { silent: true })).toEqual(expected)
})
it.each(['/api/v1/sync/changes','/api/v1/sync/changes?since=now','/api/v1/sync/bootstrap'])('rejects truncated %s without returning a partial cursor', async path => {
  vi.stubGlobal('fetch', vi.fn(async () => streamed(['{"data":{"cursor":"new","products":['])))
  await expect(request(path, { silent: true })).rejects.toMatchObject({ code: 'SYNC_RESPONSE_INCOMPLETE' })
})
it('rejects an interrupted body after successful HTTP headers', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => streamed(['{"data":'], true)))
  await expect(request('/api/v1/sync/changes', { silent: true })).rejects.toMatchObject({ code: 'SYNC_RESPONSE_INCOMPLETE' })
})
it('keeps the timeout active while the response body is stalled', async () => {
  vi.useFakeTimers()
  let aborted = false
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"data":'))
      options.signal.addEventListener('abort', () => { aborted = true; controller.error(options.signal.reason) })
    },
  }))))
  const pending = request('/api/v1/sync/changes', { silent: true, timeoutMs: 1000 })
  const assertion = expect(pending).rejects.toThrow('вчасно')
  await vi.advanceTimersByTimeAsync(1001)
  await assertion
  expect(aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
it('keeps the server error code for non-success responses', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"SYNC_CATALOG_COPY_INCOMPLETE","message":"Incomplete"}}', {status:503})))
  await expect(request('/api/v1/sync/changes', {silent:true})).rejects.toMatchObject({code:'SYNC_CATALOG_COPY_INCOMPLETE',status:503})
})
it('does not relabel unrelated invalid JSON as a catalog error', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => streamed(['bad json'])))
  await expect(request('/api/v1/products', {silent:true})).rejects.toBeInstanceOf(SyntaxError)
})
