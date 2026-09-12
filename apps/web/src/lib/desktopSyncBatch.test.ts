import { describe, expect, it } from 'vitest'
import type { DesktopSyncOutboxOperation } from './desktopBridge'
import { selectDesktopPushBatch, validateDesktopPushResults } from './desktopSyncBatch'

export function operation(sequence: number, name = 'Товар'): DesktopSyncOutboxOperation {
  return { sequence, operation_id: `op-${sequence}`, tenant_id: 'tenant', device_id: 'device',
    aggregate_type: 'sale', aggregate_id: `sale-${sequence}`, operation_type: 'sale.completed',
    payload: { name }, created_at: '2026-01-01T12:00:00.000Z', attempts: 0, last_error: null }
}
const bytes = (operations: DesktopSyncOutboxOperation[]) => new TextEncoder().encode(
  JSON.stringify({ reset_generation: 12, operations }),
).byteLength
const ack = (sequence: number) => ({ sequence, operation_id: `op-${sequence}`, status: 'synced' as const })

describe('bounded desktop mirror transport', () => {
  it('includes JSON envelope, commas, UTF-8 and the exact boundary', () => {
    const rows = [operation(1, 'Ремінь 🔧'.repeat(20)), operation(2)]
    expect(selectDesktopPushBatch(rows, 12, bytes(rows)).operations).toEqual(rows)
    expect(selectDesktopPushBatch(rows, 12, bytes(rows) - 1).operations).toEqual(rows.slice(0, 1))
  })
  it('does not skip a large operation to send potentially dependent rows', () => {
    const rows = [operation(1), operation(2, 'x'.repeat(2000)), operation(3)]
    expect(selectDesktopPushBatch(rows, 12, bytes([rows[0]]) + 10)).toEqual({ operations: [rows[0]], oversized: null })
  })
  it('identifies only an oversized first operation without dropping it', () => {
    const rows = [operation(1, 'x'.repeat(2000)), operation(2)]
    expect(selectDesktopPushBatch(rows, 12, 1000)).toEqual({ operations: [], oversized: rows[0] })
  })
  it('handles an empty queue', () => {
    expect(selectDesktopPushBatch([], 12)).toEqual({ operations: [], oversized: null })
  })
  it('accepts reordered matching acknowledgements', () => {
    expect(validateDesktopPushResults([operation(1), operation(2)], [ack(2), ack(1)])).toEqual([ack(1), ack(2)])
  })
  it('retries missing acknowledgements while preserving confirmed documents', () => {
    expect(validateDesktopPushResults([operation(1), operation(2)], [ack(1)]))
      .toEqual([ack(1), expect.objectContaining({ sequence: 2, status: 'failed' })])
  })
  it.each([
    undefined, {}, [null], [ack(3)], [ack(1), ack(1)],
    [{ ...ack(1), operation_id: 'different' }], [{ ...ack(1), status: 'unknown' }],
  ])('rejects malformed or unrelated acknowledgements: %j', (response) => {
    expect(() => validateDesktopPushResults([operation(1)], response)).toThrow()
  })
})
