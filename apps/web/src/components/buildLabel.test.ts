import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildLabel, formatBuildStamp } from './buildLabel'

// 22.11.2026, прохання власника: «на другому ПК не видно, яка версія програми й чи оновилась — потрібна назва й версія збірки вгорі».
describe('build label at the top of the screen', () => {
  it('shows the build time in Kyiv, short', () => {
    expect(formatBuildStamp('2026-11-22T16:25:07.000Z')).toBe('22.11 18:25')
    expect(formatBuildStamp('2026-07-01T09:05:00.000Z')).toBe('01.07 12:05')
    expect(formatBuildStamp('')).toBeNull()
    expect(formatBuildStamp(undefined)).toBeNull()
    expect(formatBuildStamp('not a date')).toBeNull()
  })

  it('names the main till, the manager PC and the web, so two PCs can be compared at a glance', () => {
    const build = { releaseId: '20261122T162507-097f27520102', builtAt: '2026-11-22T16:25:07.000Z' }
    expect(buildLabel({ desktop: true, build })).toEqual({ text: 'Каса · зб. 22.11 18:25', title: 'Збірка програми: 20261122T162507-097f27520102', updateWaiting: false })
    expect(buildLabel({ desktop: true, build, managerPc: true })?.text).toBe('ПК менеджера · зб. 22.11 18:25')
    expect(buildLabel({ desktop: true, build, managerPc: true, stagedUpdateReleaseId: 'next' })?.updateWaiting).toBe(true)
    expect(buildLabel({ desktop: false, webBuiltAt: '2026-11-22T16:30:00.000Z', webCommit: 'e405c3a' })).toEqual({ text: 'Веб · зб. 22.11 18:30', title: 'Збірка вебу: e405c3a', updateWaiting: false })
    expect(buildLabel({ desktop: true, build: null })).toBeNull()
    expect(buildLabel({ desktop: false, webBuiltAt: null })).toBeNull()
  })

  it('is visible in the menu and on the sign-in page', () => {
    expect(readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8')).toContain('<BuildBadge />')
    expect(readFileSync(new URL('../pages/LoginPage.tsx', import.meta.url), 'utf8')).toContain('<BuildBadge className="mt-1" />')
  })
})
