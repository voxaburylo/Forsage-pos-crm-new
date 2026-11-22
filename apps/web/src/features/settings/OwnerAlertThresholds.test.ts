import { describe, expect, it } from 'vitest'
import { alertsToForm, formToAlerts } from './OwnerAlertThresholds'

// Етап 11 (22.11.2026): пороги тривог власнику; межі ті самі, що на сервері.
describe('owner alert thresholds', () => {
  const defaults = { till_offline_minutes: 15, work_from_hour: 8, work_to_hour: 19, cash_diff_kopecks: 20_000, backup_max_hours: 36, shift_open_hours: 24 }
  it('shows the cash difference in hryvnias and reads it back in kopecks', () => {
    const form = alertsToForm(defaults)
    expect(form.cash_diff_kopecks).toBe('200')
    expect(formToAlerts({ ...form, cash_diff_kopecks: '150,5' })?.cash_diff_kopecks).toBe(15050)
    expect(formToAlerts(form)).toEqual(defaults)
  })
  it('refuses a day that ends before it starts and values out of range', () => {
    const form = alertsToForm(defaults)
    expect(formToAlerts({ ...form, work_from_hour: '19', work_to_hour: '8' })).toBeNull()
    expect(formToAlerts({ ...form, till_offline_minutes: '1' })).toBeNull()
    expect(formToAlerts({ ...form, backup_max_hours: 'abc' })).toBeNull()
  })
})
