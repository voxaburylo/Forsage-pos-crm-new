import { describe, expect, it, vi } from 'vitest'
import { applyChatCrossNumbers } from './aiCrossApply'

describe('chat cross numbers on the till', () => {
  it('adds numbers with their source and skips missing cards with a reason', async () => {
    const changeCrossNumbers = vi.fn(async (id: string) => { if (id === 'gone') throw new Error('Товар не знайдено'); return [] })
    const result = await applyChatCrossNumbers([
      { product_id: 'p1', numbers: [{ number: 'W 811/80', source: 'mann-filter.com' }, { number: 'OC 21', source: 'knecht.de' }] },
      { product_id: 'gone', numbers: [{ number: 'X1234', source: 'a.example' }] },
      { product_id: 'p2', numbers: [] },
    ], { changeCrossNumbers })
    expect(changeCrossNumbers).toHaveBeenCalledWith('p1', { add: ['W 811/80', 'OC 21'], source: 'ШІ-помічник: mann-filter.com, knecht.de' })
    expect(result).toMatchObject({ products: 1, numbers: 2 })
    expect(result.skipped.map(row => row.error)).toEqual(['Товар не знайдено', 'Немає номерів для додавання'])
  })

  // 23.11.2026: бренд номера зберігається в картці — «Hyundai: a, b; Kia: c».
  it('passes the brand of each number to the till', async () => {
    const changeCrossNumbers = vi.fn(async () => [])
    await applyChatCrossNumbers([{ product_id: 'p1', numbers: [
      { number: '26300-35503', brand: 'Hyundai', source: 'avtopro.ua' }, { number: 'W 811/80', brand: ' MANN ', source: 'avtopro.ua' }, { number: 'X1', source: 'avtopro.ua' },
    ] }], { changeCrossNumbers })
    expect(changeCrossNumbers).toHaveBeenCalledWith('p1', {
      add: [{ number: '26300-35503', brand: 'Hyundai' }, { number: 'W 811/80', brand: 'MANN' }, 'X1'], source: 'ШІ-помічник: avtopro.ua' })
  })
})
