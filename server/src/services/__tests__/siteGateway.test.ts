import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../db/pg.js', () => ({ pool: { query } }))
import { SITE_ACTIONS, auditSummary, callSiteGateway, checkSiteCall, forgetSiteKey, notifyNewSiteOrder, readSiteKey, siteGatewayAction } from '../siteGatewayService.js'

const user = { id: 'u1', tenant_id: 't1' }
const answer = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

// 24.11.2026: розділ «Сайт» керує сайтом forsage-tires.com через його шлюз; ключ шлюзу — лише на сервері програми.
describe('site gateway proxy', () => {
  beforeEach(() => query.mockReset())

  it('passes only known actions and never lets purchase, wholesale or minimal prices out', () => {
    expect(checkSiteCall('orders.list', { limit: 50 })).toEqual({ action: 'orders.list', params: { limit: 50 }, changes: false })
    expect(checkSiteCall('banners.upsert', { title: 'Зима', action: 'x' })).toEqual({ action: 'banners.upsert', params: { title: 'Зима' }, changes: true })
    for (const bad of ['orders.drop', 'constructor', '', null, 5]) expect(() => checkSiteCall(bad, {})).toThrow('Невідома дія')
    expect(() => checkSiteCall('orders.list', [1])).toThrow('Некоректні параметри')
    expect(() => checkSiteCall('products.site_fields.set', { program_product_id: 'p', specs: { purchase_price: 5 } })).toThrow('на сайт не передаються')
    expect(() => checkSiteCall('promos.upsert', { items: [{ min_price: 1 }] })).toThrow('на сайт не передаються')
    expect(() => checkSiteCall('settings.set', { values: { contact_phone1: '1', admin_password: 'x' } })).toThrow('Невідоме налаштування сайту: admin_password')
    expect(checkSiteCall('settings.set', { values: { contact_phone1: '1' } }).changes).toBe(true)
    expect(Object.keys(SITE_ACTIONS)).toHaveLength(29)
  })

  it('adds the key on the server and sends the action in the body', async () => {
    const fetchImpl = answer({ ok: true, data: [] })
    expect(await callSiteGateway('orders.list', { limit: 5 }, { fetchImpl, key: 'secret-key', url: 'https://site.test/api' })).toEqual([])
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://site.test/api')
    expect(init.headers['x-site-key']).toBe('secret-key')
    expect(JSON.parse(init.body)).toEqual({ limit: 5, action: 'orders.list' })
  })

  it('says in plain words what went wrong', async () => {
    await expect(callSiteGateway('orders.list', {}, { key: 'k', fetchImpl: answer({ ok: false, error: 'Замовлення не знайдено' }) })).rejects.toThrow('Сайт відмовив: Замовлення не знайдено')
    await expect(callSiteGateway('orders.list', {}, { key: 'k', fetchImpl: answer({ ok: false }, 401) })).rejects.toMatchObject({ code: 'SITE_GATEWAY_KEY_REJECTED' })
    await expect(callSiteGateway('orders.list', {}, { key: 'k', fetchImpl: vi.fn(async () => new Response('<html>', { status: 404 })) as unknown as typeof fetch })).rejects.toMatchObject({ code: 'SITE_GATEWAY_NOT_READY' })
    await expect(callSiteGateway('orders.list', {}, { key: 'k', fetchImpl: vi.fn(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }) }) as unknown as typeof fetch })).rejects.toThrow('не відповів за 15 секунд')
    await expect(callSiteGateway('orders.list', {}, { key: 'k', fetchImpl: vi.fn(async () => { throw new Error('net') }) as unknown as typeof fetch })).rejects.toThrow('Немає звʼязку із сайтом')
  })

  it('writes every accepted change to the audit log, and nothing for reads or refused changes', async () => {
    query.mockResolvedValue({ rows: [] })
    await siteGatewayAction(user, 'orders.list', {}, { key: 'k', fetchImpl: answer({ ok: true, data: [] }) })
    expect(query).not.toHaveBeenCalled()
    await expect(siteGatewayAction(user, 'orders.update', { id: 'o1', status: 'shipped' }, { key: 'k', fetchImpl: answer({ ok: false, error: 'ні' }) })).rejects.toThrow('Сайт відмовив')
    expect(query).not.toHaveBeenCalled()
    await siteGatewayAction(user, 'orders.update', { id: 'o1', status: 'shipped', tracking_number: '204500' }, { key: 'k', fetchImpl: answer({ ok: true, data: { id: 'o1' } }) })
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, values] = query.mock.calls[0]
    expect(sql).toContain('INSERT INTO audit_log')
    expect(values.slice(0, 4)).toEqual(['t1', 'u1', 'SITE_ORDERS_UPDATE', 'o1'])
    expect(JSON.parse(values[4])).toEqual({ id: 'o1', status: 'shipped', tracking_number: '204500' })
  })

  // 24.11.2026 (доповнення розробника сайту): ключ лежить у хмарі програми, сервер бере його функцією й тримає в памʼяті.
  it('reads the site key from the program cloud once, keeps it in memory, forgets it when the site rejects it', async () => {
    forgetSiteKey()
    query.mockResolvedValueOnce({ rows: [{ key: ' cloud-key ' }] })
    const fetchImpl = answer({ ok: true, data: { site: 'forsage-tires.com' } })
    expect(await callSiteGateway('ping', {}, { fetchImpl })).toEqual({ site: 'forsage-tires.com' })
    await callSiteGateway('ping', {}, { fetchImpl })
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toBe('SELECT public.site_link_get_key() AS key')
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1].headers['x-site-key']).toBe('cloud-key')
    expect(await readSiteKey(Date.now() + 5 * 60_000)).toBe('cloud-key')
    await expect(callSiteGateway('ping', {}, { fetchImpl: answer({ ok: false }, 401) })).rejects.toMatchObject({ code: 'SITE_GATEWAY_KEY_REJECTED' })
    query.mockResolvedValueOnce({ rows: [{ key: 'new-key' }] })
    expect(await readSiteKey()).toBe('new-key')
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('says the link is not set up when the cloud has no key, without leaking the database error', async () => {
    forgetSiteKey()
    query.mockRejectedValueOnce(new Error('function public.site_link_get_key() does not exist: secret'))
    await expect(readSiteKey()).rejects.toMatchObject({ code: 'SITE_GATEWAY_NOT_CONFIGURED', status: 503 })
    await expect(readSiteKey().catch(error => String(error.message))).resolves.not.toContain('secret')
    forgetSiteKey()
    query.mockResolvedValueOnce({ rows: [{ key: '' }] })
    await expect(readSiteKey()).rejects.toMatchObject({ code: 'SITE_GATEWAY_NOT_CONFIGURED' })
    expect(checkSiteCall('ping', {})).toEqual({ action: 'ping', params: {}, changes: false })
  })

  it('a change that could not be logged is reported, long texts are cut in the log, the bot hook does nothing yet', async () => {
    query.mockRejectedValueOnce(new Error('db'))
    await expect(siteGatewayAction(user, 'home.set', { blocks: [] }, { key: 'k', fetchImpl: answer({ ok: true }) })).rejects.toMatchObject({ code: 'SITE_AUDIT_FAILED' })
    expect(auditSummary({ content: 'я'.repeat(500), blocks: [1, 2], specs: { a: 1 }, hidden: true })).toEqual({ content: 'я'.repeat(200) + '…', blocks: 'список (2)', specs: ['a'], hidden: true })
    await expect(notifyNewSiteOrder({ id: 'o1' })).resolves.toBeUndefined()
  })
})
