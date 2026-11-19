import { describe, expect, it, vi } from 'vitest'
import { getNbuRate, parseNbuRate } from '../nbuRateService.js'

describe('NBU exchange rate', () => {
  it('reads the official rate of the requested currency', () => {
    expect(parseNbuRate('USD', [{ r030: 840, txt: 'Долар США', rate: 45.202, cc: 'USD', exchangedate: '19.11.2026' }]))
      .toEqual({ currency: 'USD', rate: 45.202, date: '19.11.2026' })
    expect(() => parseNbuRate('USD', [])).toThrow('Введіть курс вручну')
  })
  it('caches the rate for an hour and reports an unreachable NBU', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => [{ cc: 'EUR', rate: 52.1, exchangedate: '19.11.2026' }] })) as any
    await getNbuRate('eur', fetcher, 1_000)
    await getNbuRate('EUR', fetcher, 2_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await expect(getNbuRate('GBP', vi.fn(async () => { throw new Error('offline') }) as any, 3_000)).rejects.toThrow('Не вдалося отримати курс НБУ')
  })
})
