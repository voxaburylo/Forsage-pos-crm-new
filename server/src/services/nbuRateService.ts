import { AppError } from '../middleware/errorHandler.js'

/**
 * Офіційний курс НБУ на сьогодні (відкритий API Нацбанку) для перерахунку накладних у валюті.
 * Кешується на годину: курс НБУ змінюється раз на день.
 */
const NBU_URL = 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json&valcode='
const CACHE_MS = 60 * 60 * 1000
const cache = new Map<string, { at: number; value: NbuRate }>()

export interface NbuRate { currency: string; rate: number; date: string }

export function parseNbuRate(currency: string, body: unknown): NbuRate {
  const row = Array.isArray(body) ? body.find((item: any) => item?.cc === currency) : null
  const rate = Number(row?.rate)
  if (!row || !Number.isFinite(rate) || rate <= 0 || rate > 100000) throw new AppError('NBU_RATE_UNAVAILABLE', 'НБУ не повернув курс ' + currency + '. Введіть курс вручну.', 502)
  return { currency, rate, date: String(row.exchangedate ?? '') }
}

export async function getNbuRate(currency: string, fetcher: typeof fetch = fetch, now = Date.now()): Promise<NbuRate> {
  const code = currency.toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) throw new AppError('VALIDATION_ERROR', 'Невідома валюта', 422)
  const hit = cache.get(code)
  if (hit && now - hit.at < CACHE_MS) return hit.value
  let body: unknown
  try {
    const response = await fetcher(NBU_URL + code, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    body = await response.json()
  } catch {
    throw new AppError('NBU_RATE_UNAVAILABLE', 'Не вдалося отримати курс НБУ. Введіть курс вручну.', 502)
  }
  const value = parseNbuRate(code, body)
  cache.set(code, { at: now, value })
  return value
}
