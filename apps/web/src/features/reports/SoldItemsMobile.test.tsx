import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SoldItemsMobile } from './SoldItemsMobile'
import type { SoldItem } from '@/types/report'

const item: SoldItem = { product_id: 'test', name: 'Довга назва товару', sku: 'AUTO-12345678901234567890', barcode: '2000000000001', unit: 'шт', qty_sold: 3, qty_returned: 1, qty_net: 2, revenue: 30000, refund_total: 10000, net_revenue: 20000, qty_on_hand: 4, storage_bin: 'А-12' }
describe('mobile sold items', () => {
  it('shows full identifiers, quantities, returns and money without a nested scroller', () => {
    const html = renderToStaticMarkup(<SoldItemsMobile items={[item]} />)
    for (const value of [item.name, item.sku, item.barcode!, 'А-12', 'Чисто продано', 'Середня ціна продажу', 'Повернуто:', '200,00', '100,00']) expect(html).toContain(value)
    expect(html).not.toContain('overflow-auto')
    expect(html).not.toContain('max-h-')
    expect(html).not.toContain('<table')
    expect(html).toContain('overflow-wrap:anywhere')
  })
  it('does not invent a unit price for return-only rows', () => {
    const html = renderToStaticMarkup(<SoldItemsMobile items={[{ ...item, qty_sold: 0, revenue: 0, qty_net: -1, net_revenue: -10000 }]} />)
    expect(html).not.toContain('NaN')
    expect(html).not.toContain('Infinity')
    expect(html).toContain('-100,00')
  })
})
