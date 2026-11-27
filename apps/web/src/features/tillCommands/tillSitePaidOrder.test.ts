import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SITE_PAID_MARK, STOCK_CONFLICT_MARK, checkTillOrder, sitePaidNote, stockShortages, tillOrderToCreate, type TillOrderCard } from './tillOrderModel'
import { sitePaidState } from '@/features/orders/SitePaidOrderNotice'

// 27.11.2026, завдання власника: оплачене на сайті замовлення — звичайне замовлення «сайт» з позначкою «оплачено»;
// товару не вистачає — все одно створити, але з позначкою «КОНФЛІКТ: товару не вистачає». Дані з літерою «s».
const card: TillOrderCard = { id: '11111111-2222-4333-8444-555555555555', name: 'Фільтр s', sku: 'W712', retail_price: 25000, purchase_price: 15000, qty_on_hand: 3, qty_available: 1 }
const cards = new Map([[card.id, card]])
const blank = { source: 'site' as const, customer_phone: '0991112233', customer_name: 'Ольга s', comment: 'Замовлення із сайту № 21',
  paid: { amount: 50000, paid_at: '2026-11-27T10:05:00Z' }, items: [{ name: 'Фільтр s', qty: 2, sell_price: 25000, product_id: card.id }] }

describe('a paid site order on the till', () => {
  it('keeps the paid amount only for site orders and writes it as the first note', () => {
    expect(checkTillOrder(blank).paid).toEqual({ amount: 50000, paid_at: '2026-11-27T10:05:00.000Z' })
    expect(checkTillOrder({ ...blank, source: null }).paid).toBeUndefined()
    expect(() => checkTillOrder({ ...blank, paid: { amount: -1 } })).toThrow('оплати')
    // Українська розбивка тисяч — нерозривний пробіл («1 155»).
    expect(sitePaidNote({ amount: 115500, paid_at: null }).replace(/\s/g, ' ')).toBe(`${SITE_PAID_MARK} (онлайн): 1 155,00 грн. Гроші не в касі — при видачі не брати оплату вдруге.`)
  })

  it('creates the order even without enough free stock, with a conflict line on top; the item stays from the warehouse (reserved)', () => {
    expect(stockShortages(checkTillOrder(blank), cards)).toEqual(['«Фільтр s» (вільно 1, треба 2)'])
    const created = tillOrderToCreate(blank, null, '00000000-0000-4000-8000-000000000001', cards)
    const lines = String(created.comment).split('\n')
    expect(lines[0]).toBe(`${STOCK_CONFLICT_MARK}: «Фільтр s» (вільно 1, треба 2). Гроші вже сплачено — вирішіть: повернути чи привезти.`)
    expect(lines[1].startsWith(SITE_PAID_MARK)).toBe(true)
    expect(created.source).toBe('site')
    expect(created.items[0]).toMatchObject({ product_id: card.id, qty: 2, source_type: 'warehouse' })
    expect(sitePaidState(created.comment)).toEqual({ paid: true, conflict: lines[0] })
  })

  it('no conflict when the free stock is enough', () => {
    const created = tillOrderToCreate({ ...blank, items: [{ ...blank.items[0], qty: 1 }] }, null, '00000000-0000-4000-8000-000000000002', cards)
    expect(String(created.comment)).not.toContain(STOCK_CONFLICT_MARK)
    expect(sitePaidState(created.comment)).toEqual({ paid: true, conflict: null })
  })

  // 27.11.2026, правило власника: без оплати товар не бронюється; менеджер натискає «Оплачено» — тоді бронь.
  it('a payment confirmed by the manager is marked as such and still reserves', () => {
    const manual = checkTillOrder({ ...blank, paid: { amount: 50000, paid_at: '2026-11-27T12:00:00Z', method: 'manual', confirmed_by: 'Ельдар s' } })
    expect(manual.paid).toEqual({ amount: 50000, paid_at: '2026-11-27T12:00:00.000Z', method: 'manual', confirmed_by: 'Ельдар s' })
    expect(sitePaidNote(manual.paid!)).toMatch(/^ОПЛАЧЕНО НА САЙТІ \(підтвердив менеджер Ельдар s\): /)
    const created = tillOrderToCreate({ ...manual, items: [{ ...blank.items[0], qty: 1 }] }, null, '00000000-0000-4000-8000-000000000003', cards)
    expect(sitePaidState(created.comment).paid).toBe(true)
    expect(created.items[0]).toMatchObject({ source_type: 'warehouse' })
  })

  it('the till uses the same mark to name a paid site order when it refuses to sell reserved stock', () => {
    const desktop = readFileSync(path.resolve(__dirname, '../../../../desktop/src/repositories/pos/reservedStock.ts'), 'utf8')
    expect(desktop).toContain(`export const SITE_PAID_MARK = '${SITE_PAID_MARK}'`)
  })
})
