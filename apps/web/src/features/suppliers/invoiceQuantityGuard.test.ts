import { describe, expect, it } from 'vitest'
import { captureInvoiceQuantities, nextInvoiceItems } from './invoiceQuantityGuard'

describe('invoice quantity guard', () => {
  it('posts the final visible 98 instead of the earlier 46 or 56', () => {
    for (const qty of [46, 56]) {
      const old = [{ client_key: 'circle', qty, purchase_price: 1000, total: qty * 1000 }]
      const frozen = captureInvoiceQuantities(old, [{ client_key: 'circle', value: '98' }])
      expect(frozen[0]).toMatchObject({ qty: 98, total: 98000 })
      expect(old[0].qty).toBe(qty)
    }
  })

  it('keeps later scan/import additions after a manual edit', () => {
    let rows = [{ client_key: 'circle', qty: 46, purchase_price: 1000, total: 46000 }]
    rows = nextInvoiceItems(rows, prev => prev.map(item => ({ ...item, qty: 56 })))
    rows = nextInvoiceItems(rows, prev => prev.map(item => ({ ...item, qty: item.qty + 42 })))
    expect(captureInvoiceQuantities(rows, [])[0]).toMatchObject({ qty: 98, total: 98000 })
  })

  it('preserves the submission snapshot while other work finishes', () => {
    const rows = [{ client_key: 'circle', qty: 98, purchase_price: 1000, total: 98000 }]
    const frozen = captureInvoiceQuantities(rows, [])
    rows[0].qty = 56
    expect(frozen[0].qty).toBe(98)
  })

  it.each(['', '0', '-1', 'abc', 'Infinity'])('rejects invalid visible quantity %s before any write', value => {
    expect(() => captureInvoiceQuantities([{ client_key: 'circle', qty: 46, purchase_price: 1000, total: 46000 }], [{ client_key: 'circle', value }])).toThrow('Рядок 1')
  })

  it('matches fields by row identity after deletion or reordering, and accepts decimals', () => {
    const rows = [{ client_key: 'b', qty: 46, purchase_price: 1000, total: 46000 }, { client_key: 'a', qty: 56, purchase_price: 1000, total: 56000 }]
    expect(captureInvoiceQuantities(rows, [{client_key:'a',value:'98'},{client_key:'b',value:'1,5'}]).map(row=>row.qty)).toEqual([1.5,98])
  })
})
