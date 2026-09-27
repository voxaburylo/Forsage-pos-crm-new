import { describe, expect, it } from 'vitest'
import { ActionScope } from './actionScope'
describe('UI action scope', () => {
  it('rejects every additional action synchronously until completion', () => {
    const scope = new ActionScope(), first = scope.begin()!
    for (let i = 0; i < 1000; i++) expect(scope.begin()).toBeNull()
    expect(first.isCurrent()).toBe(true)
    first.finish()
    expect(scope.busy).toBe(false)
    expect(first.isCurrent()).toBe(false)
    expect(scope.begin()).not.toBeNull()
  })
  it('detaches late success/error from a different customer or closed screen', () => {
    const scope = new ActionScope(), old = scope.begin()!
    scope.invalidate()
    const current = scope.begin()!
    expect(old.isCurrent()).toBe(false)
    old.finish()
    expect(scope.busy).toBe(true)
    expect(current.isCurrent()).toBe(true)
    current.finish()
    expect(scope.busy).toBe(false)
  })
  it('an old finally cannot release a newer action after repeated completion', () => {
    const scope = new ActionScope(), old = scope.begin()!
    old.finish()
    const next = scope.begin()!
    old.finish()
    expect(next.isCurrent()).toBe(true)
    scope.invalidate()
    next.finish()
    expect(scope.busy).toBe(false)
  })
})
