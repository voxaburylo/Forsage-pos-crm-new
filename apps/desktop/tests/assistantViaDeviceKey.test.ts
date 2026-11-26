import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { TillDeviceLink, isAssistantRequest } from '../src/link/tillDeviceLink'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'
import { isLanProxyChannel } from '../src/lan/localNetwork'
import { webRpcChannelAllowed } from '../src/lan/webRpcChannels'

// 24.11.2026 (власник: «прибери пароль у ШІ-помічнику»): помічник на головному ПК ходить на сервер ключем ПК.
describe('assistant requests go with the main PC key', () => {
  function link(overrides: Record<string, unknown> = {}) {
    const request = vi.fn(async () => ({ status: 200, headers: { get: () => 'application/x-ndjson' }, text: async () => '{"data":{"reply":"ok"}}\n' }))
    const instance = new TillDeviceLink({
      fetch: vi.fn(), request, apiUrl: () => 'https://server.test/', deviceId: () => 'device-1',
      readKey: () => ({ token: 'secret-token', tenant_id: 'tenant-1' }), writeKey: () => undefined, canRun: () => true,
      execute: async () => null, ...overrides,
    } as never)
    return { instance, request }
  }

  it('only assistant addresses pass; the AI key, other server sections and odd paths never do', () => {
    for (const [method, path] of [['GET', '/ai/status'], ['POST', '/ai/chat'], ['GET', '/ai/nbu-rate?currency=USD'], ['POST', '/vin/ocr'],
      ['DELETE', '/ai/memory/7b1f'], ['POST', '/assistant-upload']]) expect(isAssistantRequest(method, path), method + ' ' + path).toBe(true)
    for (const [method, path] of [['POST', '/ai/config'], ['POST', '/ai/test'], ['GET', '/ai/config?x=1'], ['POST', '/sync/push'], ['POST', '/server-data'],
      ['GET', '/ai/../sync/push'], ['GET', '/admin/users'], ['PUT', '/ai/chat'], ['GET', '/assistant-upload'], ['POST', '/ai/'], ['POST', 'https://evil.test/ai/chat']]) {
      expect(isAssistantRequest(method, path), method + ' ' + path).toBe(false)
    }
  })

  // 24.11.2026: розділ «Сайт» власника ходить тим самим ключем; сама адреса сайту (/site/…) — ні.
  it('the owner site section passes, the site address itself does not', () => {
    for (const [method, path] of [['GET', '/site-admin'], ['PUT', '/site-admin'], ['POST', '/site-admin/key'], ['DELETE', '/site-admin/key'], ['GET', '/site-admin/orders']])
      expect(isAssistantRequest(method, path), method + ' ' + path).toBe(true)
    for (const [method, path] of [['GET', '/supplier-photos'], ['GET', '/supplier-photos?since=2026-11-24T10%3A00%3A00.000Z'], ['GET', '/site-photos'], ['GET', '/site-photos?since=2026-11-24T10%3A00%3A00.000Z']]) expect(isAssistantRequest(method, path), method + ' ' + path).toBe(true)
    for (const [method, path] of [['POST', '/site-photos'], ['GET', '/site-photos?x=1'], ['GET', '/site-photosx'], ['POST', '/site/orders'], ['GET', '/site-adminx'], ['GET', '/site-admin/../sync/push'], ['PATCH', '/site-admin']])
      expect(isAssistantRequest(method, path), method + ' ' + path).toBe(false)
  })

  // 26.11.2026: «Сайт → Усі товари» і спільний чат помічника — з головного ПК теж його ключем.
  it('the site catalog list, a supplier offer card and the shared chat pass; nothing beyond them', () => {
    for (const [method, path] of [['GET', '/site-admin/catalog?q=%D1%84%D1%96%D0%BB%D1%8C%D1%82%D1%80&source=all&flag=&page=2&per_page=50'],
      ['GET', '/site-admin/catalog/offers/0b6f4c1e-1111-4222-8333-944455556666%3AABC-12'], ['PATCH', '/site-admin/catalog/offers/0b6f4c1e-1111-4222-8333-944455556666%3AABC-12'],
      ['POST', '/site-admin/catalog/offers/bulk'], ['PUT', '/ai/chat-state?kind=assistant'], ['GET', '/ai/chat-state?kind=invoice'], ['POST', '/ai/jobs/0b6f4c1e-1111-4222-8333-944455556666/start']])
      expect(isAssistantRequest(method, path), method + ' ' + path).toBe(true)
    for (const [method, path] of [['DELETE', '/site-admin/catalog/offers/bulk'], ['PATCH', '/site-admin/catalog/../../sync/push'], ['PUT', '/ai/chat-state?kind=other'],
      ['PUT', '/ai/memory'], ['PATCH', '/site-admin/catalogx']])
      expect(isAssistantRequest(method, path), method + ' ' + path).toBe(false)
  })

  it('sends the PC key and the employee role, and returns the answer as it is', async () => {
    const { instance, request } = link()
    const answer = await instance.assistant({ method: 'POST', path: '/ai/chat', body: '{"messages":[]}', role: 'cashier' })
    expect(answer).toEqual({ status: 200, content_type: 'application/x-ndjson', text: '{"data":{"reply":"ok"}}\n' })
    const [url, init] = request.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body?: string }]
    expect(url).toBe('https://server.test/api/v1/till-device/ai/chat')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ Authorization: 'Device device-1.secret-token', 'X-Forsage-Client': 'desktop', 'X-Forsage-Staff-Role': 'cashier' })
    expect(init.body).toBe('{"messages":[]}')
  })

  it('a GET has no body; a forbidden address or a PC without a key sends nothing', async () => {
    const { instance, request } = link()
    await instance.assistant({ method: 'GET', path: '/ai/status', role: 'owner' })
    expect((request.mock.calls[0] as unknown as [string, { body?: string }])[1].body).toBeUndefined()
    await expect(instance.assistant({ method: 'POST', path: '/ai/config', body: '{}', role: 'owner' })).rejects.toThrow('не належить помічнику')
    expect(request).toHaveBeenCalledTimes(1)
    const noKey = link({ readKey: () => null })
    await expect(noKey.instance.assistant({ method: 'GET', path: '/ai/status', role: 'owner' })).rejects.toThrow('не налаштовано')
    expect(noKey.request).not.toHaveBeenCalled()
  })

  it('the till lets the same roles use it as the server lets use the assistant; it is this PC only, never the web or the manager PC', () => {
    for (const role of ['owner', 'admin', 'manager', 'cashier']) expect(isDesktopChannelAllowed('desktop:link:assistant', role)).toBe(true)
    for (const role of ['storekeeper', 'sto_viewer', 'tire_worker']) expect(isDesktopChannelAllowed('desktop:link:assistant', role)).toBe(false)
    expect(isLanProxyChannel('desktop:link:assistant')).toBe(false)
    expect(webRpcChannelAllowed('desktop:link:assistant')).toBe(false)
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    // Роль береться із сесії каси, а не з того, що надіслав екран.
    expect(main).toContain("if (!isMainTill() || !getTillDeviceLink().available()) return null\n    return getTillDeviceLink().assistant({ method: String(input?.method ?? 'GET').toUpperCase(), path: String(input?.path ?? ''),\n      body: typeof input?.body === 'string' ? input.body : undefined, role: session.role, staffId: session.id })")
  })
})
