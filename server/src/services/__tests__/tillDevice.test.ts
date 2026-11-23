import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../db/pg.js', () => ({ pool: { query } }))
import { authenticateTillDevice, parseDeviceAuthorization, registerTillDevice } from '../tillDeviceService.js'
import { isWriteAllowed } from '../../middleware/localFirstWriteGuard.js'

// 22.11.2026, «головний ПК — тимчасовий сервер магазину»: веб працював через головний ПК, лише поки в програмі
// хтось увійшов. Тепер ПК має власний ключ зв'язку й забирає запити вебу й на екрані входу.
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

describe('the main PC has its own link key', () => {
  beforeEach(() => query.mockReset())

  it('issues a random key and stores only its hash', async () => {
    query.mockResolvedValue({ rowCount: 1 })
    const first = await registerTillDevice('t', 'u', id(4))
    const second = await registerTillDevice('t', 'u', id(4))
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(second.token).not.toBe(first.token)
    const params = query.mock.calls[0][1]
    expect(params).toEqual(['t', id(4), sha(first.token), 'u'])
    expect(JSON.stringify(query.mock.calls)).not.toContain(first.token)
    // Повторна видача замінює старий ключ того самого магазину, чужий — ніколи.
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT (device_id) DO UPDATE')
    expect(query.mock.calls[0][0]).toContain('WHERE till_devices.tenant_id = EXCLUDED.tenant_id')
  })

  it('refuses a device that belongs to another shop, and a malformed device id', async () => {
    query.mockResolvedValue({ rowCount: 0 })
    await expect(registerTillDevice('t', 'u', id(4))).rejects.toMatchObject({ status: 403 })
    await expect(registerTillDevice('t', 'u', 'not-a-device')).rejects.toMatchObject({ status: 422 })
  })

  it('recognises the device only by the right key', async () => {
    const token = 'k'.repeat(43)
    query.mockResolvedValue({ rows: [{ tenant_id: 't', token_hash: sha(token), created_by: 'owner-1' }] })
    // 23.11.2026: разом із пристроєм — хто видав йому ключ (від його імені йдуть зміни каси).
    await expect(authenticateTillDevice(id(4), token)).resolves.toEqual({ tenant_id: 't', device_id: id(4), created_by: 'owner-1' })
    await expect(authenticateTillDevice(id(4), 'x'.repeat(43))).resolves.toBeNull()
    query.mockResolvedValue({ rows: [] })
    await expect(authenticateTillDevice(id(5), token)).resolves.toBeNull()
    expect(query.mock.calls.at(-1)![1]).toEqual([id(5)])
  })

  it('reads the key only from a well-formed header', () => {
    const token = 'A-b_9'.repeat(9)
    expect(parseDeviceAuthorization(`Device ${id(4)}.${token}`)).toEqual({ deviceId: id(4), token })
    for (const header of [undefined, '', `Bearer ${token}`, `Device ${id(4)}`, `Device ${id(4)}.short`, `Device not-a-device.${token}`, `Device ${id(4)}.${token} extra`])
      expect(parseDeviceAuthorization(header)).toBeNull()
  })

  it('only the till program may use the device addresses, and they do not need a staff session', () => {
    const req = (path: string, desktop: boolean) => ({ method: 'POST', path, get: (name: string) => (desktop && name === 'x-forsage-client' ? 'desktop' : undefined) })
    for (const path of ['/api/v1/till-device/register', '/api/v1/till-device/beat', '/api/v1/till-device/rpc/claim', `/api/v1/till-device/rpc/${id(1)}/result`]) {
      expect(isWriteAllowed(req(path, false) as never), path).toBe(false)
      expect(isWriteAllowed(req(path, true) as never), path).toBe(true)
    }
    const routes = readFileSync(new URL('../../routes/tillDevice.ts', import.meta.url), 'utf8')
    // Видати ключ може лише власник чи адміністратор; решта адрес упізнає сам пристрій, а не людину.
    expect(routes).toContain("tillDeviceRouter.post('/register', requireAuth, requireRole('owner', 'admin')")
    for (const path of ["'/beat'", "'/rpc/claim'", "'/rpc/:id/result'"]) expect(routes).toContain(`tillDeviceRouter.post(${path}, requireTillDevice`)
    expect(routes).not.toContain('tillDeviceRouter.use(requireAuth)')
  })

  it('the key table is closed to browsers', () => {
    const migration = readFileSync(new URL('../../../../supabase/migrations/20261122170000_till_devices.sql', import.meta.url), 'utf8')
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('REVOKE ALL ON public.till_devices FROM anon, authenticated')
    expect(migration).toContain('token_hash')
    expect(migration).not.toMatch(/\btoken text\b/)
  })
})
