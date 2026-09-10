import { describe, expect, it } from 'vitest'
import { aiChatStorageKey, readAiChat } from './aiChatStorage'
import { toDraft, toPayload } from './OrderConfirmModal'
import { notificationLink } from '../notifications/notificationLink'

describe('AI and notification input boundaries', () => {
  it.each(['abc', '', '1шт', '-1', '0', '1.2345'])('never replaces quantity %s with one', (qty) => {
    expect(() => toPayload(toDraft({ items: [{ name: 'Filter', qty, sell_price_uah: 10 }] }))).toThrow('кількість')
  })
  it('does not silently drop a nameless row or an invalid price', () => {
    expect(() => toPayload(toDraft({ items: [{ name: '', qty: 2 }] }))).toThrow('назву')
    expect(() => toPayload(toDraft({ items: [{ name: 'Filter', qty: 2, sell_price_uah: 'garbage' }] }))).toThrow('ціни')
  })
  it('preserves a valid fractional row and a VIN-only order', () => {
    expect(toPayload(toDraft({ items: [{ name: 'Oil', qty: '2,5', sell_price_uah: '123,50' }] })).items[0].qty).toBe('2,5')
    expect(toPayload(toDraft({ vin: 'WVWZZZ1JZXW000001' })).vin).toBe('WVWZZZ1JZXW000001')
    expect(() => toPayload(toDraft({ car_year: '2020.5' }))).toThrow('рік')
  })
  it('separates tenant, user and invoice history', () => {
    expect(new Set([aiChatStorageKey('a', 't', false), aiChatStorageKey('b', 't', false), aiChatStorageKey('a', 'x', false), aiChatStorageKey('a', 't', true)]).size).toBe(4)
  })
  it('loads bounded history without accessing the legacy shared key', () => {
    const keys: string[] = []
    const storage = { getItem(key: string) { keys.push(key); return JSON.stringify({ entries: Array.from({ length: 100 }, () => ({ role: 'user', text: 'hello' })), applied: [] }) } } as Storage
    const key = aiChatStorageKey('a', 't', false)
    expect(readAiChat(key, storage).entries).toHaveLength(80)
    expect(keys).toEqual([key])
    expect(readAiChat(key, { getItem: () => 'broken' } as unknown as Storage)).toEqual({})
  })
  it.each(['javascript:alert(1)', 'https://outside.test', '//outside.test', '/\\outside.test', '/\n/outside.test'])('refuses unsafe notification link %s', value => expect(notificationLink(value)).toBeNull())
  it('keeps safe document navigation inside the SPA', () => expect(notificationLink('/orders/one?view=items')).toBe('/orders/one?view=items'))
})
