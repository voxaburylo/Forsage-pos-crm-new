import { describe, it, expect } from 'vitest'
import { parseLocaleNumber } from './parseDecimal'

describe('parseLocaleNumber', () => {
  // Головний баг: SheetJS повертає 1343.6 як "1,343.60" (US-формат), а старий
  // парсер робив із коми тисяч другу крапку → 1.343.
  it('handles US thousands + dot decimal from SheetJS raw:false', () => {
    expect(parseLocaleNumber('1,343.60')).toBeCloseTo(1343.6)
    expect(parseLocaleNumber('1,179.60')).toBeCloseTo(1179.6)
    expect(parseLocaleNumber('1,260.20')).toBeCloseTo(1260.2)
    expect(parseLocaleNumber('1,234,567.89')).toBeCloseTo(1234567.89)
  })

  it('handles European space thousands + comma decimal', () => {
    expect(parseLocaleNumber('1 343,60')).toBeCloseTo(1343.6)
    expect(parseLocaleNumber('1 234 567,89')).toBeCloseTo(1234567.89)
    expect(parseLocaleNumber('1.343,60')).toBeCloseTo(1343.6)
  })

  it('handles plain values without thousands separators', () => {
    expect(parseLocaleNumber('315,40')).toBeCloseTo(315.4)
    expect(parseLocaleNumber('315.40')).toBeCloseTo(315.4)
    expect(parseLocaleNumber('366,20')).toBeCloseTo(366.2)
    expect(parseLocaleNumber('1343.6')).toBeCloseTo(1343.6)
    expect(parseLocaleNumber('315')).toBe(315)
  })

  it('treats a lone comma/dot before three digits as a thousands separator', () => {
    expect(parseLocaleNumber('1,343')).toBe(1343)
    expect(parseLocaleNumber('1.234')).toBe(1234)
  })

  it('strips currency symbols and handles negatives', () => {
    expect(parseLocaleNumber('₴ 1 999,00')).toBeCloseTo(1999)
    expect(parseLocaleNumber('-15,5')).toBeCloseTo(-15.5)
  })

  it('returns NaN for empty / non-numeric input', () => {
    expect(Number.isNaN(parseLocaleNumber(''))).toBe(true)
    expect(Number.isNaN(parseLocaleNumber(null))).toBe(true)
    expect(Number.isNaN(parseLocaleNumber('абв'))).toBe(true)
  })
})
