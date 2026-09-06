import { describe, expect, it } from 'vitest'
import { InventoryScanJournal } from './inventoryScanJournal'

function store() {
  const data = new Map<string, string>()
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
}

describe('durable pending scans', () => {
  it('restores accepted scans with the same IDs after recreating the journal', () => {
    const storage = store()
    const journal = new InventoryScanJournal(storage)
    const first = journal.add('a', { barcode: '123', qty: 1 })
    const second = journal.add('a', { barcode: '123', qty: 1 })
    expect(first.operation_id).not.toBe(second.operation_id)
    expect(new InventoryScanJournal(storage).list('a')).toEqual([first, second])
  })
  it('does not duplicate an in-flight ID and rejects changed quantity', () => {
    const journal = new InventoryScanJournal(store())
    const request = journal.add('a', { barcode: '123' })
    expect(journal.add('a', request)).toEqual(request)
    expect(journal.list('a')).toHaveLength(1)
    expect(() => journal.add('a', { ...request, qty: 2 })).toThrow('змінилися')
  })
  it('removes only the acknowledged scan from its revision', () => {
    const journal = new InventoryScanJournal(store())
    const a = journal.add('a', { barcode: '123' })
    const b = journal.add('a', { barcode: '456' })
    journal.add('b', { barcode: '123' })
    journal.acknowledge('a', a.operation_id!)
    expect(journal.list('a')).toEqual([b])
    expect(journal.list('b')).toHaveLength(1)
    journal.clear('a')
    expect(journal.list('b')).toHaveLength(1)
  })
  it('fails closed when writing is unavailable', () => {
    const storage = store()
    storage.setItem = () => { throw new Error('disk full') }
    expect(() => new InventoryScanJournal(storage).add('a', { barcode: '123' })).toThrow('disk full')
    expect(storage.data.size).toBe(0)
  })
  it('preserves a damaged journal rather than replacing it with an empty queue', () => {
    const storage = store()
    storage.setItem('forsage:inventory-scans:v1:a', 'invalid JSON')
    const journal = new InventoryScanJournal(storage)
    expect(() => journal.list('a')).toThrow()
    expect(() => journal.add('a', { barcode: '123' })).toThrow()
    expect(storage.getItem('forsage:inventory-scans:v1:a')).toBe('invalid JSON')
  })
  it('keeps a committed-but-unacknowledged scan available after a simulated crash', () => {
    const storage = store()
    const request = new InventoryScanJournal(storage).add('a', { barcode: '123' })
    const receipts = new Set<string>()
    let qty = 0
    const apply = (id: string) => { if (!receipts.has(id)) { receipts.add(id); qty++ } }
    apply(request.operation_id!)
    const reopened = new InventoryScanJournal(storage)
    for (const item of reopened.list('a')) { apply(item.operation_id!); reopened.acknowledge('a', item.operation_id!) }
    expect(qty).toBe(1)
    expect(reopened.list('a')).toEqual([])
  })
})
