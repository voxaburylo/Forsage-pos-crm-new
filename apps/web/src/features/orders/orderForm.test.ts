import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_SELLER, loadOrderThumbnails, orderFormHtml, orderItemStateText } from './orderDocuments'
import type { CustomerOrder } from './orderApi'

// 23.11.2026, план 4.3 (етап 4): бланк замовлення — клієнт і авто зверху, позиції таблицею, підсумок і внесене внизу;
// друкований бланк читабельний і з мініатюрами позицій.
const order = {
  id: 'o1', order_number: 1042, created_at: '2026-11-23T08:00:00Z', comment: 'Передзвонити <завтра>',
  pickup_deadline_at: '2026-11-30T08:00:00Z', pickup_cell: 'A-3',
  customer: { id: 'c1', full_name: 'Іван Петренко', phone: '+380671112233' },
  vehicle_info: { make: 'Hyundai', model: 'Tucson', year: 2018, vin: 'KMHJ381ABJU000001', engine_volume: '2.0' },
  total_paid: 50000, prepayment: 50000,
  items: [
    { id: 'i1', name: 'Фільтр масляний MANN W 811/80', sku: 'W811/80', qty: 2, sell_price: 32000, product_id: 'p1', source_type: 'warehouse', item_status: 'pending' },
    { id: 'i2', name: 'Колодки гальмівні', sku: null, qty: 1, sell_price: 125000, product_id: 'p2', source_type: 'supplier', item_status: 'ordered', expected_date: '2026-11-25' },
    { id: 'i3', name: 'Скасована', sku: null, qty: 1, sell_price: 99900, product_id: null, source_type: 'supplier', item_status: 'canceled' },
    { id: 'i4', name: 'Нотатка', qty: 1, sell_price: 0, product_id: null, is_draft_note: true },
  ],
} as unknown as CustomerOrder

describe('printed order form', () => {
  const html = orderFormHtml(order, { ...EMPTY_SELLER, name: 'Форсаж', phone: '+380500000000' }, {
    p1: 'data:image/png;base64,iVBORw0KGgo=', p2: 'file:///C:/photos/x.jpg',
  })

  it('client and car on top, number and date', () => {
    expect(html).toContain('Замовлення № 1042')
    expect(html).toContain('Іван Петренко')
    expect(html).toContain('Hyundai Tucson 2018')
    expect(html).toContain('VIN KMHJ381ABJU000001')
    expect(html.indexOf('Іван Петренко')).toBeLessThan(html.indexOf('<table class="items">'))
  })

  it('lines as a table with thumbnails; cancelled lines and notes are not printed', () => {
    expect(html).toContain('<img class="thumb" src="data:image/png;base64,iVBORw0KGgo="')
    // file:-адреса у бланк не потрапляє — лише порожнє місце під фото.
    expect(html).not.toContain('file:///')
    expect(html).toContain('<div class="noimg"></div>')
    expect(html).not.toContain('Скасована')
    expect(html).not.toContain('Нотатка')
    expect(html).toContain('640,00')
  })

  it('total, paid and due at the bottom', () => {
    const bottom = html.slice(html.indexOf('<table class="sum">'))
    expect(bottom).toMatch(/Разом<\/td><td class="r">1\s?890,00 грн/)
    expect(bottom).toMatch(/Внесено<\/td><td class="r">500,00 грн/)
    expect(bottom).toMatch(/До сплати<\/td><td class="r">1\s?390,00 грн/)
    expect(html.indexOf('<table class="sum">')).toBeGreaterThan(html.indexOf('<table class="items">'))
  })

  it('escapes what people typed', () => {
    expect(html).toContain('Передзвонити &lt;завтра&gt;')
    expect(html).toContain('Комірка: <b>A-3</b>')
  })

  it('line state in plain words', () => {
    expect(orderItemStateText({ source_type: 'warehouse', item_status: 'pending' })).toBe('Є на складі')
    expect(orderItemStateText({ source_type: 'supplier', item_status: 'pending' })).toBe('Під замовлення')
    expect(orderItemStateText({ source_type: 'supplier', item_status: 'ordered', expected_date: '2026-11-25' })).toMatch(/^Замовлено · очікуємо /)
    expect(orderItemStateText({ item_status: 'arrived' })).toBe('Прибуло')
    expect(orderItemStateText({ item_status: 'handed' })).toBe('Видано')
  })
})

describe('thumbnails come from the main PC and never hold the print up', () => {
  it('asks once for the products of the order', async () => {
    const read = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, 'data:image/png;base64,AA=='])))
    expect(await loadOrderThumbnails(order, read)).toEqual({ p1: 'data:image/png;base64,AA==', p2: 'data:image/png;base64,AA==' })
    expect(read).toHaveBeenCalledWith(['p1', 'p2'])
  })

  it('no main PC, an error or a slow answer — prints without photos', async () => {
    expect(await loadOrderThumbnails(order)).toEqual({})
    expect(await loadOrderThumbnails(order, async () => { throw new Error('offline') })).toEqual({})
    vi.useFakeTimers()
    try {
      const slow = loadOrderThumbnails(order, () => new Promise(() => {}))
      await vi.advanceTimersByTimeAsync(3000)
      expect(await slow).toEqual({})
    } finally { vi.useRealTimers() }
  })
})

describe('the form on screen', () => {
  const form = readFileSync(new URL('./OrderFormPage.tsx', import.meta.url), 'utf8')

  it('lines are a table on a wide screen with the same columns as the header; cards on a phone', () => {
    expect(form).toContain("const ORDER_ITEM_COLUMNS = 'lg:grid-cols-[")
    expect(form).toContain("'hidden px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500 lg:grid lg:gap-x-2 ' + ORDER_ITEM_COLUMNS")
    expect(form).toContain("'px-3 py-3 sm:px-4 lg:grid lg:items-center lg:gap-x-2 lg:gap-y-2 lg:py-2 ' + ORDER_ITEM_COLUMNS")
    // Підписи полів лишаються для програм читання з екрана і для телефона.
    expect(form).toContain('<span className="mb-1 block text-xs text-gray-600 lg:sr-only">Кількість</span>')
    expect(form).toContain('data-order-line-sum')
  })

  it('total and paid under the lines; the printed form is in the documents', () => {
    expect(form).toContain('data-order-items-total')
    expect(form).toContain("onClick={() => printDoc('form')}>Бланк замовлення</Button>")
    expect(read('./OrderDetailPage.tsx')).toContain('🖨 Бланк замовлення')
  })
})

function read(file: string) { return readFileSync(new URL(file, import.meta.url), 'utf8') }
