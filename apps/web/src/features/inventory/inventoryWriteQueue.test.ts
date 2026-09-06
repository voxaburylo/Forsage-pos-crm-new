import { describe, expect, it } from 'vitest'
import { InventoryWriteQueue } from './inventoryWriteQueue'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('inventory write ordering', () => {
  it('keeps 3 → 8 → 3 even while the first save is delayed', async () => {
    const queue = new InventoryWriteQueue()
    const first = gate()
    const writes: number[] = []
    let stored = 3
    const a = queue.run(async () => { await first.promise; stored = 8; writes.push(8) })
    const b = queue.run(async () => { stored = 3; writes.push(3) })
    await Promise.resolve()
    expect(writes).toEqual([])
    first.resolve()
    await Promise.all([a, b])
    expect(writes).toEqual([8, 3])
    expect(stored).toBe(3)
  })

  it('waits for all steps of an operation before starting the next', async () => {
    const queue = new InventoryWriteQueue()
    const price = gate()
    const events: string[] = []
    const a = queue.run(async () => { events.push('count'); await price.promise; events.push('price') })
    const b = queue.run(async () => { events.push('next') })
    await Promise.resolve()
    expect(events).toEqual(['count'])
    price.resolve()
    await Promise.all([a, b])
    expect(events).toEqual(['count', 'price', 'next'])
  })

  it('reports a failure without retrying it or blocking the next edit', async () => {
    const queue = new InventoryWriteQueue()
    let attempts = 0
    const failure = new Error('response lost')
    const a = queue.run(async () => { attempts++; throw failure })
    const b = queue.run(async () => 3)
    await expect(a).rejects.toBe(failure)
    await expect(b).resolves.toBe(3)
    expect(attempts).toBe(1)
  })

  it('also recovers from a synchronous exception', async () => {
    const queue = new InventoryWriteQueue()
    const a = queue.run(() => { throw new Error('invalid') })
    const b = queue.run(async () => 'saved')
    await expect(a).rejects.toThrow('invalid')
    await expect(b).resolves.toBe('saved')
  })
})
