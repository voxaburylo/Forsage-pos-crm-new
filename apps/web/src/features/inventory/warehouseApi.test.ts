import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { warehouseApi } from './warehouseApi'
const state = vi.hoisted(() => ({
  local: true, ready: true, user: 'owner',
  createMovement: vi.fn(), createReserve: vi.fn(), createConsumption: vi.fn(), createWriteoff: vi.fn(), releaseReserve: vi.fn(),
  listReserves: vi.fn(), listMovements: vi.fn(), resolveOperation: vi.fn(),
  remote: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))
vi.mock('@/lib/api', () => ({ api: state.remote }))
vi.mock('@/lib/desktopBridge', () => ({ desktopBridge: () => state.local ? { warehouse: state.ready ? state : undefined } : null }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ session: { user: { id: state.user } } }) } }))
const values = new Map<string, string>()
beforeEach(() => {
  values.clear(); vi.resetAllMocks(); state.local = true; state.ready = true; state.user = 'owner'
  state.resolveOperation.mockRejectedValue(Error('still offline'))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  })
})
afterEach(() => vi.unstubAllGlobals())
const writes = [
  ['movement', () => warehouseApi.createMovement({ product_id: 'p', qty: 8, from_bin: 'A', to_bin: 'B' }), state.createMovement],
  ['reserve', () => warehouseApi.createReserve({ product_id: 'p', qty: 0.125, expires_at: '2030-01-01T00:00:00Z' }), state.createReserve],
  ['consumption', () => warehouseApi.createConsumption({ employee_id: 'e', items: [{ product_id: 'p', qty: 0.125 }] }), state.createConsumption],
  ['writeoff', () => warehouseApi.createWriteoff({ reason: 'damage', items: [{ product_id: 'p', qty: 0.125 }] }), state.createWriteoff],
] as const

describe('warehouse local-only mutation and durable retries', () => {
  for (const [name, write, send] of writes) {
    it(name + ': lost reply reuses the same operation; success allows a new operation', async () => {
      send.mockRejectedValueOnce(Error('reply lost')).mockResolvedValue({ id: 'saved' })
      await expect(write()).rejects.toThrow('reply lost')
      expect(values.size).toBe(1)
      const first = send.mock.calls[0][0].operation_id
      expect(first).toEqual(expect.any(String))
      await write()
      expect(send.mock.calls[1][0].operation_id).toBe(first)
      expect(values.size).toBe(0)
      await write()
      expect(send.mock.calls[2][0].operation_id).not.toBe(first)
      expect(state.remote.post).not.toHaveBeenCalled()
    })
    it(name + ': simultaneous identical sends are coalesced before IPC', async () => {
      send.mockResolvedValue({ id: 'saved' })
      await Promise.all([write(), write()])
      expect(send).toHaveBeenCalledOnce()
    })
    it.each(['web', 'not-ready'])(name + ': cannot write or fall back remotely from %s', async mode => {
      state.local = mode !== 'web'; state.ready = false
      await expect(write()).rejects.toThrow('локальній')
      expect(send).not.toHaveBeenCalled()
      expect(values.size).toBe(0)
      expect(state.remote.post).not.toHaveBeenCalled()
    })
  }
  for (const [kind, write, send] of writes.filter(row => row[0] !== 'writeoff')) {
    it.each(['other', ''])(kind + ': user switch/logout (%s) keeps the original attempt without resolving as another user', async nextUser => {
      let rejectWrite!: (error: Error) => void
      send.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectWrite = reject }))
      const pending = write()
      const rejected = expect(pending).rejects.toThrow('reply lost')
      await Promise.resolve()
      expect(send).toHaveBeenCalledOnce()
      state.user = nextUser
      rejectWrite(Error('reply lost'))
      await rejected
      expect(state.resolveOperation).not.toHaveBeenCalled()
      expect(values.size).toBe(1)
      expect([...values.keys()][0]).toBe('forsage:pending-request:v1:' + kind + ':owner')
      state.user = 'owner'
      expect(warehouseApi.pendingOperations(kind)).toHaveLength(1)
    })
    it(kind + ': user switch before dispatch prevents sending with a different session', async () => {
      const pending = write()
      state.user = 'other'
      await expect(pending).rejects.toThrow('Користувач змінився')
      expect(send).not.toHaveBeenCalled()
      expect(state.resolveOperation).not.toHaveBeenCalled()
      expect(values.size).toBe(1)
      state.user = 'owner'
      expect(warehouseApi.pendingOperations(kind)).toHaveLength(1)
    })
    it(kind + ': recovers a committed reply without a second send', async () => {
      send.mockRejectedValueOnce(Error('reply lost'))
      state.resolveOperation.mockResolvedValue({ status: 'committed', result: { id: 'saved' } })
      expect(await write()).toEqual({ id: 'saved' })
      expect(send).toHaveBeenCalledOnce()
      expect(values.size).toBe(0)
    })
    it(kind + ': confirmed absence unlocks correction only after fencing the old ID', async () => {
      send.mockRejectedValueOnce(Error('invalid stock')).mockResolvedValue({ id: 'saved' })
      state.resolveOperation.mockResolvedValue({ status: 'not_committed' })
      await expect(write()).rejects.toThrow('invalid stock')
      const firstId = send.mock.calls[0][0].operation_id
      expect(state.resolveOperation).toHaveBeenCalledWith(kind, firstId)
      expect(values.size).toBe(0)
      await write()
      expect(send.mock.calls[1][0].operation_id).not.toBe(firstId)
    })
    it(kind + ': unresolved legacy attempt blocks different content and can be reconciled without sending', async () => {
      const key = 'forsage:pending-request:v1:' + kind + ':owner'
      values.set(key, JSON.stringify({ '{"product_id":"other"}': 'old-id' }))
      await expect(write()).rejects.toThrow('попередню спробу')
      expect(send).not.toHaveBeenCalled()
      expect(warehouseApi.pendingOperations(kind)).toHaveLength(1)
      state.resolveOperation.mockResolvedValue({ status: 'committed', result: { id: 'old-result' } })
      expect(await warehouseApi.resolveOperation(kind, 'old-id')).toEqual({ status: 'committed', result: { id: 'old-result' } })
      expect(values.size).toBe(0)
      expect(send).not.toHaveBeenCalled()
    })
  }
  it.each(['null', '[]', '{broken', '{"not-json":"id"}', '{"{}":""}'])('preserves a corrupt pending journal %s', raw => {
    values.set('forsage:pending-request:v1:reserve:owner', raw)
    expect(() => warehouseApi.pendingOperations('reserve')).toThrow()
    expect(values.get('forsage:pending-request:v1:reserve:owner')).toBe(raw)
  })
  it('malformed resolution cannot unlock the journal', async () => {
    values.set('forsage:pending-request:v1:reserve:owner', '{"{}":"id"}')
    state.resolveOperation.mockResolvedValue({ status: 'committed' })
    await expect(warehouseApi.resolveOperation('reserve', 'id')).rejects.toThrow('підтвердити')
    expect(values.size).toBe(1)
  })
  it('cannot reconcile another user journal or an arbitrary operation ID', async () => {
    values.set('forsage:pending-request:v1:reserve:owner', '{"{}":"id"}')
    state.user = 'other'
    expect(warehouseApi.pendingOperations('reserve')).toEqual([])
    await expect(warehouseApi.resolveOperation('reserve', 'id')).rejects.toThrow('не знайдено')
    expect(state.resolveOperation).not.toHaveBeenCalled()
    expect(values.size).toBe(1)
  })
  it('missing recovery support in an old EXE fails before a write', async () => {
    state.resolveOperation = undefined as unknown as typeof state.resolveOperation
    await expect(warehouseApi.createReserve({ product_id: 'p', qty: 1 })).rejects.toThrow('оновлена')
    expect(state.createReserve).not.toHaveBeenCalled()
    expect(values.size).toBe(0)
    state.resolveOperation = vi.fn()
  })
  it('release is local-only, including failures and bridge not ready', async () => {
    state.releaseReserve.mockRejectedValue(Error('local failure'))
    await expect(warehouseApi.releaseReserve('r')).rejects.toThrow('local failure')
    expect(state.releaseReserve).toHaveBeenCalledOnce()
    state.local = false
    await expect(warehouseApi.releaseReserve('r')).rejects.toThrow('локальній')
    expect(state.remote.delete).not.toHaveBeenCalled()
  })
  it('an explicit writeoff identity is preserved unchanged', async () => {
    state.createWriteoff.mockResolvedValue({ id: 'w' })
    const body = { operation_id: 'stable-id', reason: 'damage' as const, items: [{ product_id: 'p', qty: 2 }] }
    expect(await warehouseApi.createWriteoff(body)).toEqual({ data: { id: 'w' } })
    expect(state.createWriteoff).toHaveBeenCalledWith(body)
    expect(values.size).toBe(0)
  })
  it('local read errors do not silently return server data', async () => {
    state.listReserves.mockRejectedValue(Error('local read failed'))
    await expect(warehouseApi.listReserves()).rejects.toThrow('local read failed')
    expect(state.remote.get).not.toHaveBeenCalled()
  })
  it('read-only web list remains available', async () => {
    state.local = false; state.remote.get.mockResolvedValue({ data: [] })
    expect(await warehouseApi.listReserves()).toEqual({ data: [] })
    expect(state.remote.get).toHaveBeenCalledWith('/api/v1/reserves')
  })
})
