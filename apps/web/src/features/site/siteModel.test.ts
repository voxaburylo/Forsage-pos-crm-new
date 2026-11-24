import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { categoryRows, priceExample, readMinOrder, readPercent } from './siteModel'
import { isAssistantPath } from '@/lib/assistantViaMainPc'
import { navigationAllowed } from '@/lib/navigationAccess'

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

// 24.11.2026 (власник: «окремий розділ Сайт, керую всім сам, поки лише в акаунті власника»).
describe('site section', () => {
  it('reads the price change and the smallest order the way a person types them', () => {
    expect(readPercent('')).toBe(0)
    expect(readPercent('-5')).toBe(-5)
    expect(readPercent('−7,5')).toBe(-7.5)
    expect(() => readPercent('-60')).toThrow('від −50 до 100')
    expect(() => readPercent('abc')).toThrow()
    expect(readMinOrder('')).toBe(0)
    expect(readMinOrder('300')).toBe(30000)
    expect(readMinOrder('99,5')).toBe(9950)
    expect(() => readMinOrder('-1')).toThrow()
    expect(priceExample(-10)).toContain('900 грн')
  })

  it('shows categories as a tree and loses none, even with a broken parent', () => {
    const rows = categoryRows([{ id: 'a', parent_id: null, name: 'Оливи' }, { id: 'b', parent_id: 'a', name: 'Моторні' }, { id: 'c', parent_id: 'zzz', name: 'Шини' },
      { id: 'x', parent_id: 'y', name: 'Коло 1' }, { id: 'y', parent_id: 'x', name: 'Коло 2' }])
    expect(rows.slice(0, 3)).toEqual([{ id: 'a', name: 'Оливи', depth: 0 }, { id: 'b', name: 'Моторні', depth: 1 }, { id: 'c', name: 'Шини', depth: 0 }])
    expect(rows.map(row => row.id).sort()).toEqual(['a', 'b', 'c', 'x', 'y'])
  })

  it('only the owner sees the section: menu, route and the server', () => {
    expect(read('../../components/Sidebar.tsx')).toMatch(/to: '\/site',[^\n]*label: 'Сайт',\s+roles: \['owner'\] \}/)
    expect(read('../../App.tsx')).toContain(`<Route path="/site" element={<ProtectedRoute roles={['owner']}><SitePage /></ProtectedRoute>} />`)
    expect(read('../../../../../server/src/routes/site.ts')).toContain("siteAdminRouter.use(requireAuth, requireRole('owner'))")
    expect(navigationAllowed('/site', false)).toBe(true)
  })

  it('on the main PC the section works without a second password, like the assistant', () => {
    expect(isAssistantPath('/api/v1/site-admin')).toBe(true)
    expect(isAssistantPath('/api/v1/site-admin/key')).toBe(true)
    expect(isAssistantPath('/api/v1/site-adminx')).toBe(false)
    expect(isAssistantPath('/api/v1/site/orders')).toBe(false)
  })
})
