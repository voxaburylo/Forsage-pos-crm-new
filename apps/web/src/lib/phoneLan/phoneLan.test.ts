import { describe, expect, it } from 'vitest'
import { parsePhoneQr, phoneQrText, validPairing } from './phoneLan'

// 27.11.2026: QR-код «Телефони через Wi-Fi» з головного ПК. Лише локальні адреси (телефон не має ходити кудись в інтернет
// із кодом головного ПК), код — 32 знаки. Дані з літерою «s».
describe('phone pairing from the main PC QR code', () => {
  const key = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
  it('reads back exactly what the main PC shows', () => {
    const text = phoneQrText({ host: '192.168.1.10', port: 3210, key })
    expect(text).toBe(`forsage-phone:192.168.1.10:3210:${key}`)
    expect(parsePhoneQr(text)).toEqual({ host: '192.168.1.10', port: 3210, key })
    expect(parsePhoneQr(`  forsage-phone:10.0.0.5:47821:${key.toUpperCase()}  `)).toEqual({ host: '10.0.0.5', port: 47821, key })
    expect(validPairing({ host: '172.20.3.4', port: '3210', key })).toEqual({ host: '172.20.3.4', port: 3210, key })
  })
  it('refuses other QR codes, internet addresses, bad ports and short codes', () => {
    expect(() => parsePhoneQr('https://s.example.com')).toThrow('Це не QR-код')
    expect(() => parsePhoneQr(`forsage-phone:8.8.8.8:3210:${key}`)).toThrow('локальна')
    expect(() => validPairing({ host: '192.168.1.300', port: 3210, key })).toThrow('локальна')
    expect(() => validPairing({ host: '172.32.0.1', port: 3210, key })).toThrow('локальна')
    expect(() => validPairing({ host: '192.168.1.10', port: 80, key })).toThrow('порт')
    expect(() => validPairing({ host: '192.168.1.10', port: 3210, key: 'abc-s' })).toThrow('32 знаки')
  })
})
