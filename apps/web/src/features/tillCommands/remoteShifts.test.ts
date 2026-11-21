import { describe, expect, it } from 'vitest'
import { parseRemoteShifts } from './RemoteShiftsCard'

describe('open shifts reported by the till', () => {
  const shift = { id: 's1', cashier_id: 'c1', cashier_name: 'Касир', opened_at: '2026-11-21T08:00:00.000Z', expected_cash: 125050 }
  it('accepts a complete list, including an empty one', () => {
    expect(parseRemoteShifts({ shifts: [] })).toEqual([])
    expect(parseRemoteShifts({ shifts: [shift, { ...shift, id: 's2', cashier_name: null }] })).toEqual([shift, { ...shift, id: 's2', cashier_name: null }])
  })
  it('never shows a broken reply as "no open shifts"', () => {
    expect(() => parseRemoteShifts(null)).toThrow('без списку')
    expect(() => parseRemoteShifts({})).toThrow('без списку')
    expect(() => parseRemoteShifts({ shifts: [{ ...shift, expected_cash: 12.5 }] })).toThrow('пошкоджений')
    expect(() => parseRemoteShifts({ shifts: [{ ...shift, id: 5 }] })).toThrow('пошкоджений')
  })
})
