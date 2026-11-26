import { describe, expect, it } from 'vitest'
import { siteCancelPlan } from './tillSiteCancel'
import { checkTillOrder, tillOrderToCreate } from './tillOrderModel'

// 27.11.2026: замовлення із сайту — звичайне замовлення з джерелом «сайт»; скасоване на сайті каса скасовує лише без грошей.
describe('site orders on the till', () => {
  const blank = { customer_phone: '380991674424', customer_name: 'Іван s', comment: 'Замовлення із сайту № 15', author: 'Сайт', source: 'site', canceled: true,
    items: [{ name: 'Шина 205/55R16 Nexen', qty: 1, sell_price: 65550 }] }

  it('the source is «site» and the note has no «made in the web» line', () => {
    const order = checkTillOrder(blank)
    expect(order).toMatchObject({ source: 'site', canceled: true })
    const create = tillOrderToCreate(blank as never, 'customer-1', 'op-1')
    expect(create.source).toBe('site')
    expect(create.comment).toBe('Замовлення із сайту № 15')
    expect(create.operation_id).toBe('op-1')
  })

  it('an ordinary web order keeps its source; a made-up source is ignored', () => {
    const plain = { ...blank, source: 'telegram_bot', canceled: undefined }
    expect(checkTillOrder(plain).source).toBeUndefined()
    expect(tillOrderToCreate(plain as never, null, 'op-2').source).toBe('walk_in')
  })

  it('cancel from the site: only an order without money and not handed over', () => {
    expect(siteCancelPlan({ status: 'new', prepayment: 0, total_paid: 0 }).action).toBe('cancel')
    expect(siteCancelPlan({ status: 'canceled' }).action).toBe('nothing')
    expect(siteCancelPlan({ status: 'ready', prepayment: 50000 })).toMatchObject({ action: 'refuse' })
    expect(siteCancelPlan({ status: 'completed' }).reason).toMatch(/вже видано/)
    expect(siteCancelPlan(null).action).toBe('refuse')
  })
})
