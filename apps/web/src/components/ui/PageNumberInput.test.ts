import { expect, it } from 'vitest'
import { pageNumber } from './PageNumberInput'
it.each(['', '0', '-1', '1.5', '1e2', 'Infinity', '1000001'])('rejects invalid jump %s', value => expect(pageNumber(value)).toBeNull())
it('allows known/unknown last pages but does not clamp a typo silently', () => {
  expect(pageNumber(' 17 ', 20)).toBe(17)
  expect(pageNumber('21', 20)).toBeNull()
  expect(pageNumber('1')).toBe(1)
})
