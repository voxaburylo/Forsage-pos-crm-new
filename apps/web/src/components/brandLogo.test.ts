import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BRAND_LOGO_PATH } from './BrandLogo'

// 23.11.2026, слово власника: «буква F на жовтому фоні, а не блискавка» — однаково у вебі, у вкладці й у значку каси.
describe('one logo everywhere', () => {
  const favicon = readFileSync(new URL('../../public/favicon.svg', import.meta.url), 'utf8')
  const desktopIcon = readFileSync(new URL('../../../desktop/build/icon.svg', import.meta.url), 'utf8')

  it('the tab icon and the till app icon are the same picture', () => {
    expect(desktopIcon).toBe(favicon)
  })

  it('is the letter F on yellow, the same shape as in the menu', () => {
    expect(favicon).toContain('fill="#FFD000"')
    expect(favicon).toContain(`d="${BRAND_LOGO_PATH}"`)
  })
})
