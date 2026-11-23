import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ANALYTICS_TABS, STAFF_TABS } from './SubNavTabs'

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

// 23.11.2026 (план B5, слово власника: «зарплату теж перенести у вкладку працівників»).
describe('payroll lives in the staff section', () => {
  it('the staff section has two tabs: the team and the payroll, for the owner and the administrator only', () => {
    expect(STAFF_TABS.map(tab => [tab.to, tab.label])).toEqual([['/staff', 'Команда'], ['/analytics/payroll', 'Зарплата']])
    for (const tab of STAFF_TABS) expect(tab.roles).toEqual(['owner', 'admin'])
  })

  it('the payroll screen shows the staff tabs, not the analytics ones', () => {
    expect(ANALYTICS_TABS.some(tab => tab.to === '/analytics/payroll')).toBe(false)
    // Оболонка вибирає вкладки за адресою екрана: зарплата тепер належить лише розділу «Працівники».
    expect(read('./Layout.tsx')).toContain('STAFF_TABS,')
  })

  it('the old address and the analytics link still open the same payroll screen; money is paid at the till only', () => {
    expect(read('../App.tsx')).toContain('<Route path="/analytics/payroll"    element={<ProtectedRoute roles={ADMIN_ROLES}><PayrollPage /></ProtectedRoute>} />')
    expect(read('../features/analytics/analyticsNav.ts')).toContain("{ label: 'Зарплата та виплати', to: '/analytics/payroll', roles: ADMIN }")
    expect(read('../features/analytics/PayrollPage.tsx')).toContain('const canWrite = isDesktopRuntime()')
    // З картки працівника — одразу до його нарахувань і виплат за місяць.
    expect(read('../features/staff/StaffPage.tsx')).toContain('/analytics/payroll?employee=${encodeURIComponent(selectedUser.id)}&period=${encodeURIComponent(period)}')
  })
})
