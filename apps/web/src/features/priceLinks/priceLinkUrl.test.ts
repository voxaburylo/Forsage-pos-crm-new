import { describe, expect, it } from 'vitest'
import { priceLinkUrl } from './PriceLinkModal'

describe('client price link address', () => {
  it('points at the web version even from the till program', () => {
    expect(priceLinkUrl('A'.repeat(32), 'https://forsage-pos-crm-new-web.vercel.app/')).toBe('https://forsage-pos-crm-new-web.vercel.app/p/' + 'A'.repeat(32))
  })
})
