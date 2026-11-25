import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { handOverConfirmText, handOverDue, handOverPlan } from './HandOverOrderButton'

// 25.11.2026 (рішення власника): замовлення видає менеджер, гроші приймає каса; неоплачене — одразу борг клієнта.
describe('order hand-over button', () => {
  it('counts the unpaid rest like the till: total minus discount minus the larger of paid and prepayment', () => {
    expect(handOverDue({ id: 'o', total_amount: 30000, discount_amount: 1000, total_paid: 10000, prepayment: 10000 })).toBe(19000)
    expect(handOverDue({ id: 'o', total_amount: 30000, total_paid: 0, prepayment: 5000 })).toBe(25000)
    expect(handOverDue({ id: 'o', total_amount: 30000, total_paid: 30000 })).toBe(0)
  })

  it('warns that the unpaid rest becomes the customer debt and where it is paid', () => {
    const text = handOverConfirmText({ number: '#77', customer: 'СТО', remaining: 20000 })
    expect(text).toContain('стануть боргом клієнта')
    expect(text).toContain('«Розрахунки клієнта» → «Борг»')
    expect(handOverConfirmText({ number: '#77', customer: null, remaining: 0 })).toContain('оплачене повністю')
  })

  it('partial hand-over plan: prepayment counts first, a shortfall is debt, a surplus goes to the account', () => {
    const order = { id: 'o', total_amount: 3000, total_paid: 500, items: [
      { id: 'a', name: 'Фільтр', qty: 1, sell_price: 1000, item_status: 'arrived' },
      { id: 'b', name: 'Колодки', qty: 1, sell_price: 2000, item_status: 'ordered' },
      { id: 'c', name: 'Скасоване', qty: 1, sell_price: 9999, item_status: 'canceled' },
    ] }
    expect(handOverPlan(order, new Set(['a']))).toMatchObject({ whole: false, handed: 1000, debt: 500, toAccount: 0, restCount: 1 })
    expect(handOverPlan({ ...order, total_paid: 3000 }, new Set(['a']))).toMatchObject({ debt: 0, toAccount: 2000 })
    expect(handOverPlan({ ...order, items: order.items.map(i => ({ ...i, item_status: i.item_status === 'canceled' ? 'canceled' : 'arrived' })) }, new Set(['a', 'b'])))
      .toMatchObject({ whole: true, handed: 3000, debt: 2500, restCount: 0 })
  })

  it('is shown in the orders list and the order card, and only where the till command exists', () => {
    const list = readFileSync(new URL('./OrdersPage.tsx', import.meta.url), 'utf8')
    const card = readFileSync(new URL('./OrderDetailPage.tsx', import.meta.url), 'utf8')
    const button = readFileSync(new URL('./HandOverOrderButton.tsx', import.meta.url), 'utf8')
    expect(list).toContain('{!draft && !terminal && <HandOverOrderButton order={order} onDone={onHandedOver} />}')
    expect(card).toContain('{serverActionsReady && !terminal && <HandOverOrderButton order={order} onDone={() => { void load() }} />}')
    expect(button).toContain('if (!canHandOverHere() || !arrivedIds.length) return null')
    expect(button).toContain('Boolean(desktopBridge()?.orders?.handOver)')
  })
})
