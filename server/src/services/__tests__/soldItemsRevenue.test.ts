import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { allocateReceiptRevenue } from '../../lib/receiptRevenue.js'


describe('exact receipt allocation', () => {
  it('keeps compiled desktop and server implementations identical without runtime TS imports', () => {
    const local = readFileSync(new URL('../../../../apps/desktop/src/lib/receiptRevenue.ts', import.meta.url), 'utf8')
    const server = readFileSync(new URL('../../lib/receiptRevenue.ts', import.meta.url), 'utf8')
    expect(local.replaceAll('\r\n', '\n')).toBe(server.replaceAll('\r\n', '\n'))
  })
  it('preserves every kopeck and does not depend on query order', () => {
    for (let n = 1; n <= 100; n++) {
      const lines = Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(3, '0'), total: (i * 117 + n) % 1051 }))
      const sum = lines.reduce((s, l) => s + l.total, 0), total = Math.floor(sum * .73)
      const result = allocateReceiptRevenue(total, lines)
      expect([...result.values()].reduce((a, b) => a + b, 0)).toBe(total)
      expect(allocateReceiptRevenue(total, [...lines].reverse())).toEqual(result)
      for (const line of lines) expect(result.get(line.id)).toBeLessThanOrEqual(line.total)
    }
    expect(allocateReceiptRevenue(1, [{ id: 'b', total: 1 }, { id: 'a', total: 1 }])).toEqual(new Map([['a', 1], ['b', 0]]))
  })
  it('rejects corrupt, missing, fractional or duplicate amounts instead of inventing money', () => {
    for (const total of [NaN, Infinity, -1, .5, 2]) expect(() => allocateReceiptRevenue(total, [{ id: 'a', total: 1 }])).toThrow()
    expect(() => allocateReceiptRevenue(1, [])).toThrow()
    expect(() => allocateReceiptRevenue(1, [{ id: 'a', total: 1 }, { id: 'a', total: 1 }])).toThrow()
    expect(allocateReceiptRevenue(0, [])).toEqual(new Map())
  })
  it('protects the paid core deposit from the product discount, including a fully discounted receipt', () => {
    const lines = [{ id: 'a', total: 200, coreTotal: 100 }, { id: 'b', total: 100 }]
    expect(allocateReceiptRevenue(270, lines)).toEqual(new Map([['a', 185], ['b', 85]]))
    expect(allocateReceiptRevenue(50, lines)).toEqual(new Map([['a', 50], ['b', 0]]))
    expect(allocateReceiptRevenue(0, lines)).toEqual(new Map([['a', 0], ['b', 0]]))
    expect(() => allocateReceiptRevenue(100, [{ id: 'a', total: 100, coreTotal: 101 }])).toThrow()
  })
})
