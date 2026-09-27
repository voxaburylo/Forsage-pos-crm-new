import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { OrderLanBadge, OrderLanNotice } from './OrderLanNotice'

describe('LAN order state is explicit, not a payment or reservation', () => {
  it('does not show a warning on a normal standalone or web page', () => {
    expect(renderToStaticMarkup(<OrderLanNotice />)).toBe('')
    expect(renderToStaticMarkup(<OrderLanBadge order={{}} />)).toBe('')
  })
  it.each([
    ['pending', 'Очікує передавання'], ['blocked', 'Потрібна перевірка'], ['cached', 'Збережена копія'],
  ] as const)('distinguishes %s from the business status', (state, label) => {
    const html = renderToStaticMarkup(<OrderLanBadge order={{ lan_sync: { state, message: 'Не зарезервовано' } }} />)
    expect(html).toContain(label)
    expect(html).toContain('Не зарезервовано')
    expect(html).not.toContain('<button')
  })
})
