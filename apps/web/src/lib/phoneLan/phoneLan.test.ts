import { describe, expect, it } from 'vitest'
import { parsePhoneQr, phoneQrText, validPairing } from './phoneLan'
import { needsPhoneWifiRefresh } from './phoneWifiAutoSetup'

// 27.11.2026: доступ телефона до головного ПК через Wi-Fi. Лише локальні адреси (телефон не має ходити кудись в інтернет
// із кодом головного ПК), код — 32 знаки. Дані з літерою «s».
describe('phone pairing with the main PC', () => {
  const key = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
  it('reads back exactly what the main PC QR code shows', () => {
    const text = phoneQrText({ host: '192.168.1.10', port: 3210, key })
    expect(text).toBe(`forsage-phone:192.168.1.10:3210:${key}`)
    expect(parsePhoneQr(text)).toEqual({ hosts: ['192.168.1.10'], port: 3210, key })
    expect(parsePhoneQr(`  forsage-phone:10.0.0.5:47821:${key.toUpperCase()}  `)).toEqual({ hosts: ['10.0.0.5'], port: 47821, key })
  })
  it('keeps only local addresses of the main PC, in order, without repeats', () => {
    expect(validPairing({ hosts: ['192.168.1.10', '8.8.8.8', '172.20.3.4', '192.168.1.10', 's'], port: '3210', key }))
      .toEqual({ hosts: ['192.168.1.10', '172.20.3.4'], port: 3210, key })
  })
  it('refuses other QR codes, internet addresses, bad ports and short codes', () => {
    expect(() => parsePhoneQr('https://s.example.com')).toThrow('Це не QR-код')
    expect(() => parsePhoneQr(`forsage-phone:8.8.8.8:3210:${key}`)).toThrow('локальна')
    expect(() => validPairing({ host: '192.168.1.300', port: 3210, key })).toThrow('локальна')
    expect(() => validPairing({ hosts: ['172.32.0.1'], port: 3210, key })).toThrow('локальна')
    expect(() => validPairing({ host: '192.168.1.10', port: 80, key })).toThrow('порт')
    expect(() => validPairing({ host: '192.168.1.10', port: 3210, key: 'abc-s' })).toThrow('32 знаки')
  })
})

// 27.11.2026, слово власника: «щоб нічого не сканувати: пропав інтернет — працюємо офлайн автоматом».
describe('the phone asks the main PC for Wi-Fi access by itself while there is internet', () => {
  const now = Date.parse('2026-11-27T12:00:00Z')
  const stored = { pairing: { hosts: ['192.168.1.10'], port: 3210, key: 'a'.repeat(32) }, token: 's'.repeat(64),
    expires_at: '2026-12-20T00:00:00Z', user: { id: 'cashier', tenant_id: 't', role: 'cashier', full_name: 's', phone: '' }, refreshed_at: '2026-11-27T10:00:00Z' }
  it('asks when there is nothing, another worker, the session is ending, or it was long ago', () => {
    expect(needsPhoneWifiRefresh(null, 'cashier', now)).toBe(true)
    expect(needsPhoneWifiRefresh(stored, 'owner', now)).toBe(true)
    expect(needsPhoneWifiRefresh({ ...stored, expires_at: '2026-11-29T00:00:00Z' }, 'cashier', now)).toBe(true)
    expect(needsPhoneWifiRefresh({ ...stored, refreshed_at: '2026-11-27T01:00:00Z' }, 'cashier', now)).toBe(true)
  })
  it('does not ask again within a few hours for the same worker', () => {
    expect(needsPhoneWifiRefresh(stored, 'cashier', now)).toBe(false)
  })
})
