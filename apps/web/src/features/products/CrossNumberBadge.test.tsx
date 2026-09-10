import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CrossNumberBadge } from './CrossNumberBadge'

describe('cross-number completion badge', () => {
  const render = (count?: number) => renderToStaticMarkup(<CrossNumberBadge count={count} onEdit={() => {}} />)
  it('marks a genuinely empty card softly red', () => {
    expect(render(0)).toContain('bg-red-50')
    expect(render(0)).toContain('Крос-номери не заповнені')
  })
  it('shows saved numbers without claiming available equivalents', () => {
    expect(render(39)).toContain('<span>39</span>')
    expect(render(39)).toContain('не підтвердження сумісності')
    expect(render(39)).not.toContain('bg-red-50')
  })
  it('never treats missing data as an empty card', () => {
    expect(render()).toContain('не завантажена')
    expect(render()).not.toContain('bg-red-50')
  })
})
