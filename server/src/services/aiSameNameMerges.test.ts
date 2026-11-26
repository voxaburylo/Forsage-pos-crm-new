import { describe, expect, it } from 'vitest'
import { pickPrimary, sameNameMergePairs } from './aiSameNameMerges.js'

// 26.11.2026, власник: «щоб свої задачі виконував якісно й швидко» — пари з однаковою назвою збирає сервер, а не модель.
const card = (id: string, sku: string, qty: number, barcode: string | null = null) => ({ product_id: id, sku, name: 'Свічки NGK s', qty, barcode })

describe('same-name duplicate pairs prepared by the server', () => {
  it('the card with stock stays; then a factory barcode, then a real article (letter «s» check in the name)', () => {
    expect(pickPrimary([card('a', '81072', 0), card('b', '82305', 50)]).product_id).toBe('b')
    expect(pickPrimary([card('a', 'AUTO-1', 0), card('b', '420100', 0, '4028224420103'), card('c', '88815', 0, '2000998832551')]).product_id).toBe('b')
    expect(pickPrimary([card('a', 'AUTO-1', 0), card('b', '777', 0)]).product_id).toBe('b')
  })

  it('a group of three gives two pairs into the same main card, both sure', () => {
    const pairs = sameNameMergePairs([{ products: [card('a', '111', 0), card('b', '82305', 50), card('c', '81072', 0)] }])
    expect(pairs).toEqual([
      { primary_product_id: 'b', duplicate_product_id: 'a', sure: true, reason: 'назва збігається буква в букву' },
      { primary_product_id: 'b', duplicate_product_id: 'c', sure: true, reason: 'назва збігається буква в букву' },
    ])
  })

  it('signs of two makers go to the doubtful table: different lettered articles or different factory barcodes', () => {
    const [letters] = sameNameMergePairs([{ products: [card('a', 'CSW-2302M', 1), card('b', 'CSW-2601MT', 0)] }])
    expect(letters).toMatchObject({ sure: false, reason: 'різні артикули виробника: CSW-2302M і CSW-2601MT' })
    const [codes] = sameNameMergePairs([{ products: [card('a', '1', 1, '4008321100955'), card('b', '2', 0, '8711500482730')] }])
    expect(codes).toMatchObject({ sure: false, reason: 'різні заводські штрихкоди — можливо, різні виробники' })
    const [internal] = sameNameMergePairs([{ products: [card('a', '1', 1, '4008321100955'), card('b', '2', 0, '2000998832551')] }])
    expect(internal.sure).toBe(true)
  })

  it('stops at the limit and skips broken groups', () => {
    const groups = Array.from({ length: 10 }, (_, index) => ({ products: [card('a' + index, '1', 1), card('b' + index, '2', 0)] }))
    expect(sameNameMergePairs(groups, 4)).toHaveLength(4)
    expect(sameNameMergePairs([{ products: [card('a', '1', 1)] }])).toEqual([])
  })
})
