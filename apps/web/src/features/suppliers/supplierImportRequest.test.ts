import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { submitCatalogImport } from './supplierImportRequest'
import { pendingLocalRequests } from '@/lib/durableLocalRequest'

const values = new Map<string, string>()
const storage = { getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value) },
  removeItem: (key: string) => { values.delete(key) } } as Storage
const scope = 'supplier-import:tenant:cashier'
const payload = { filename: 'file.csv', rows: [{ name: 'A', qty: '0.125', price: 1234 }] }
const result = { success: true as const, importId: 'saved-import' }
const transport = () => ({ send: vi.fn().mockResolvedValue(result),
  resolve: vi.fn().mockRejectedValue(Error('offline')), sameSession: () => true })
beforeEach(() => { values.clear() })
afterEach(() => vi.restoreAllMocks())

it('persists identity before sending and removes it only on a valid acknowledgement', async () => {
  const t = transport()
  t.send.mockImplementation(async id => {
    expect(pendingLocalRequests(scope, storage)[0].operationId).toBe(id)
    return result
  })
  expect(await submitCatalogImport(scope, payload, t, storage)).toEqual(result)
  expect(values.size).toBe(0)
})
it('keeps the recovery marker small even for a large supplier file', async () => {
  const t = transport(); t.send.mockRejectedValue(Error('lost'))
  const large = { rows: Array.from({ length: 15000 }, (_, i) => ({ sku: 'SKU-'+i, name: 'Supplier private name '+i, qty: 123 })) }
  await expect(submitCatalogImport(scope, large, t, storage)).rejects.toThrow()
  const stored = [...values.values()].join('')
  expect(stored.length).toBeLessThan(250)
  expect(stored).not.toContain('Supplier private')
})
it('a double click shares one send and one response', async () => {
  const t = transport()
  expect(await Promise.all([submitCatalogImport(scope, payload, t, storage), submitCatalogImport(scope, payload, t, storage)]))
    .toEqual([result, result])
  expect(t.send).toHaveBeenCalledTimes(1)
})
it('refuses a different request while one is running instead of fencing the active request', async () => {
  const t = transport()
  const first = submitCatalogImport(scope, payload, t, storage)
  await expect(submitCatalogImport(scope, { changed: true }, t, storage)).rejects.toThrow(/Дочекайтеся/)
  await first
  expect(t.resolve).not.toHaveBeenCalled()
})
it('returns saved success when the write reply is lost but reconciliation works', async () => {
  const t = transport()
  t.send.mockRejectedValue(Error('lost reply')); t.resolve.mockResolvedValue({ status: 'committed', result })
  expect(await submitCatalogImport(scope, payload, t, storage)).toEqual(result)
  expect(t.resolve).toHaveBeenCalledWith(t.send.mock.calls[0][0])
  expect(values.size).toBe(0)
})
it('retains the attempt after both responses fail and reuses it in a recreated module', async () => {
  const t = transport(); t.send.mockRejectedValue(Error('lost reply'))
  await expect(submitCatalogImport(scope, payload, t, storage)).rejects.toThrow('lost reply')
  const id = t.send.mock.calls[0][0]
  vi.resetModules()
  const fresh = await import('./supplierImportRequest')
  t.send.mockResolvedValue(result)
  expect(await fresh.submitCatalogImport(scope, payload, t, storage)).toEqual(result)
  expect(t.send.mock.calls[1][0]).toBe(id)
  expect(values.size).toBe(0)
})
it('a confirmed later import gets a new ID', async () => {
  const t = transport()
  await submitCatalogImport(scope, payload, t, storage)
  await submitCatalogImport(scope, payload, t, storage)
  expect(t.send.mock.calls[0][0]).not.toBe(t.send.mock.calls[1][0])
})
it('keeps unknown prior data when the user changes the payload', async () => {
  const t = transport(); t.send.mockRejectedValue(Error('lost reply'))
  await expect(submitCatalogImport(scope, payload, t, storage)).rejects.toThrow()
  await expect(submitCatalogImport(scope, { changed: true }, t, storage)).rejects.toThrow('offline')
  expect(t.send).toHaveBeenCalledTimes(1)
  expect(values.size).toBe(1)
})
it('a changed file cannot conceal a previously committed import', async () => {
  const t = transport(); t.send.mockRejectedValue(Error('lost reply'))
  await expect(submitCatalogImport(scope, payload, t, storage)).rejects.toThrow()
  t.resolve.mockResolvedValue({ status: 'committed', result })
  await expect(submitCatalogImport(scope, { changed: true }, t, storage)).rejects.toThrow(/уже збережено/)
  expect(t.send).toHaveBeenCalledTimes(1)
  expect(values.size).toBe(0)
})
it('confirmed rollback allows a corrected file and a new ID', async () => {
  const t = transport(); t.send.mockRejectedValueOnce(Error('bad input'))
  t.resolve.mockResolvedValue({ status: 'not_committed' })
  await expect(submitCatalogImport(scope, payload, t, storage)).rejects.toThrow('bad input')
  expect(values.size).toBe(0)
  expect(await submitCatalogImport(scope, { changed: true }, t, storage)).toEqual(result)
  expect(t.send.mock.calls[0][0]).not.toBe(t.send.mock.calls[1][0])
})
it('fences an old uncommitted request before submitting a changed payload', async () => {
  const t = transport(); t.send.mockRejectedValueOnce(Error('lost'))
  await expect(submitCatalogImport(scope, payload, t, storage)).rejects.toThrow('lost')
  t.resolve.mockResolvedValue({ status: 'not_committed' })
  await submitCatalogImport(scope, { changed: true }, t, storage)
  expect(t.send).toHaveBeenCalledTimes(2)
  expect(t.send.mock.calls[0][0]).not.toBe(t.send.mock.calls[1][0])
})
it.each([null, {}, { success: false }, { success: true, importId: '' }])('does not acknowledge an invalid IPC success %s', async response => {
  const t = transport(); t.send.mockResolvedValue(response)
  await expect(submitCatalogImport(scope, payload, t, storage)).rejects.toThrow(/підтвердити/)
  expect(values.size).toBe(1)
})
it.each([null, {}, { status: 'committed', result: {} }])('does not clear evidence after malformed recovery %s', async response => {
  const t = transport(); t.send.mockRejectedValue(Error('lost')); t.resolve.mockResolvedValue(response)
  await expect(submitCatalogImport(scope, payload, t, storage)).rejects.toThrow('lost')
  expect(values.size).toBe(1)
})
it('does not write when durable storage is full', async () => {
  const t = transport()
  await expect(submitCatalogImport(scope, payload, t, { ...storage, setItem: () => { throw Error('full') } })).rejects.toThrow('full')
  expect(t.send).not.toHaveBeenCalled()
})
it('does not resolve or write with malformed pending evidence', async () => {
  values.set('forsage:pending-request:v1:' + scope, 'bad json')
  const t = transport()
  await expect(submitCatalogImport(scope, payload, t, storage)).rejects.toThrow()
  expect(t.send).not.toHaveBeenCalled(); expect(t.resolve).not.toHaveBeenCalled()
})
it('never reconciles or clears the previous user attempt after account switch', async () => {
  const t = transport()
  let current = true
  t.sameSession = () => current
  t.send.mockImplementation(async () => { current = false; throw Error('lost') })
  await expect(submitCatalogImport(scope, payload, t, storage)).rejects.toThrow(/Користувач/)
  expect(t.resolve).not.toHaveBeenCalled()
  expect(values.size).toBe(1)
})
it('fails closed if acknowledgement cleanup is not durable', async () => {
  const t = transport()
  const broken = { ...storage, removeItem: () => { throw Error('disk') } }
  await expect(submitCatalogImport(scope, payload, t, broken)).rejects.toThrow('disk')
  const id = t.send.mock.calls[0][0]
  await submitCatalogImport(scope, payload, t, storage)
  expect(t.send.mock.calls[1][0]).toBe(id)
})
it('canonical field order does not change the identity of the same pending request', async () => {
  const t = transport(); t.send.mockRejectedValueOnce(Error('lost'))
  await expect(submitCatalogImport(scope, { a: 1, b: 2 }, t, storage)).rejects.toThrow()
  await submitCatalogImport(scope, { b: 2, a: 1 }, t, storage)
  expect(t.send.mock.calls[1][0]).toBe(t.send.mock.calls[0][0])
})
