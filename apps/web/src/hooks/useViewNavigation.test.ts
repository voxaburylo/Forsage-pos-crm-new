import { describe, expect, it } from 'vitest'
import { safeReturnTarget } from './useViewNavigation'

describe('return context', () => {
  it('keeps the parent view and its own origin', () => {
    const state = { returnView: { to: '/suppliers/123', state: { returnView: { to: '/suppliers?search=a' } } } }
    expect(safeReturnTarget(state, '/suppliers/invoices')).toEqual({ to: '/suppliers/123', state: state.returnView.state })
  })
  it.each([null, {}, { returnView: { to: '//elsewhere.test' } }, { returnView: { to: 'https://elsewhere.test' } }, { returnView: { to: '/\\elsewhere.test' } }])('rejects unsafe or missing origins %j', state => {
    expect(safeReturnTarget(state, '/products')).toEqual({ to: '/products' })
  })
})
