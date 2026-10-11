import { describe, expect, it, vi } from 'vitest'
import { supersededProductSequences, type ProductOutboxVersion } from '../src/repositories/productOutboxCoalescing'

function row(sequence: number, payload = '{}', operation: ProductOutboxVersion['operation_type'] = 'product.upsert', id = 'p'): ProductOutboxVersion {
  return { sequence, aggregate_id: id, operation_type: operation, payload_json: payload }
}
const correction = '{"stock_correction":true,"qty_on_hand":0}'

// Independent baseline copied from the pre-optimization implementation.
function previousSelection(rows: readonly ProductOutboxVersion[]): number[] {
  const result: number[] = []
  for (const id of new Set(rows.map(r => r.aggregate_id))) {
    const group = rows.filter(r => r.aggregate_id === id)
    const keep = new Set([group[0].sequence])
    if (group[0].operation_type === 'product.upsert') {
      const latest = group.find(r => {
        if (r.operation_type !== 'product.upsert') return false
        try { return JSON.parse(r.payload_json)?.stock_correction === true } catch { return false }
      })
      if (latest) keep.add(latest.sequence)
    }
    for (const r of group) if (!keep.has(r.sequence)) result.push(r.sequence)
  }
  return result
}

describe('product outbox version selection', () => {
  it.each([
    ['empty', [], []],
    ['one ordinary version', [row(1)], []],
    ['ordinary versions', [row(3), row(2), row(1)], [2, 1]],
    ['newest correction', [row(3, correction), row(2, correction), row(1)], [2, 1]],
    ['older correction', [row(4), row(3), row(2, correction), row(1)], [3, 1]],
    ['multiple corrections', [row(4), row(3, correction), row(2, correction), row(1)], [2, 1]],
    ['newest deletion', [row(4, '{}', 'product.deleted'), row(3, correction), row(2)], [3, 2]],
    ['deletion does not stop older correction lookup', [row(4), row(3, '{}', 'product.deleted'), row(2, correction), row(1)], [3, 1]],
    ['correction property on deletion is ignored', [row(4), row(3, correction, 'product.deleted'), row(2, correction)], [3]],
    ['malformed newest retained', [row(4, '{'), row(3, correction), row(2)], [2]],
    ['malformed older superseded', [row(4), row(3, '{'), row(2, correction), row(1)], [3, 1]],
    ['empty product id', [row(2, '{}', 'product.upsert', ''), row(1, '{}', 'product.upsert', '')], [1]],
    ['independent groups', [row(6, '{}', 'product.upsert', ''), row(5, correction, 'product.upsert', ''), row(4), row(3), row(2, correction, 'product.upsert', 'z'), row(1, correction, 'product.upsert', 'z')], [3, 1]],
  ] satisfies Array<[string, ProductOutboxVersion[], number[]]>)('%s', (_name, rows, expected) => {
    expect(supersededProductSequences(rows)).toEqual(expected)
  })

  it.each(['null', 'true', '42', '"text"', '[]', '{"stock_correction":false}', '{"stock_correction":"true"}', '{"stock_correction":1}'])('does not treat %s as a correction', payload => {
    expect(supersededProductSequences([row(4), row(3, payload), row(2, correction), row(1)])).toEqual([3, 1])
  })

  it('does not mutate input rows, payloads or order', () => {
    const rows = Object.freeze([Object.freeze(row(3)), Object.freeze(row(2, correction)), Object.freeze(row(1))])
    const before = JSON.stringify(rows)
    expect(supersededProductSequences(rows)).toEqual([1])
    expect(JSON.stringify(rows)).toBe(before)
  })

  it('does not parse payloads after finding the latest correction or after a newest deletion', () => {
    const parse = vi.spyOn(JSON, 'parse')
    try {
      const result = supersededProductSequences([row(5, correction), row(4, '{'), row(3, '{}', 'product.deleted', 'z'), row(2, correction, 'product.upsert', 'z'), row(1, '{', 'product.upsert', 'z')])
      const calls = parse.mock.calls.length
      expect(result).toEqual([4, 2, 1])
      expect(calls).toBe(1)
    } finally { parse.mockRestore() }
  })

  it('matches the previous selection and ordering on 2000 deterministic mixed queues', () => {
    let state = 76
    const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state }
    const payloads = ['{}', correction, '{', 'null', '{"stock_correction":"true"}', '[]']
    for (let sample = 0; sample < 2000; sample++) {
      const rows: ProductOutboxVersion[] = []
      let sequence = 1
      for (const id of ['', 'a', 'A', '10', '2', 'товар']) {
        const count = next() % 15
        const group: ProductOutboxVersion[] = []
        for (let i = 0; i < count; i++) group.unshift(row(sequence++, payloads[next() % payloads.length], next() % 4 ? 'product.upsert' : 'product.deleted', id))
        rows.push(...group)
      }
      expect(supersededProductSequences(rows)).toEqual(previousSelection(rows))
    }
  })

  it('visits product identifiers linearly instead of rescanning the queue per product', () => {
    let reads = 0
    const rows: ProductOutboxVersion[] = []
    for (let product = 0; product < 1000; product++) {
      for (let version = 3; version > 0; version--) {
        rows.push({ ...row(product * 3 + version), get aggregate_id() { reads++; return String(product) } })
      }
    }
    expect(supersededProductSequences(rows)).toHaveLength(2000)
    expect(reads).toBeLessThanOrEqual(rows.length * 2)
  })
})
