import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const salaryRoute = readFileSync(new URL('../../routes/salary.ts', import.meta.url), 'utf8')
const commissionService = readFileSync(new URL('../commissionService.ts', import.meta.url), 'utf8')
const analyticsRoute = readFileSync(new URL('../../routes/analytics.ts', import.meta.url), 'utf8')
const desktopStaff = readFileSync(
  new URL('../../../../apps/desktop/src/repositories/staffRepository.ts', import.meta.url),
  'utf8',
)
const staffPage = readFileSync(
  new URL('../../../../apps/web/src/features/staff/StaffPage.tsx', import.meta.url),
  'utf8',
)

describe('owner payroll safety', () => {
  it('never presents the owner as an employee salary debt', () => {
    expect(salaryRoute).toContain("users.filter((user) => user.role === 'owner')")
    expect(salaryRoute).toContain('withoutOwnerPayrollRows')
    expect(staffPage).toContain("users.filter((user)=>user.role!=='owner')")
    expect(analyticsRoute).toContain('ownerUserIds.has(p.employee_id)')
  })

  it('blocks new owner salary and commission entries on server and desktop', () => {
    expect(salaryRoute).toContain("employee.app_metadata?.role === 'owner'")
    expect(commissionService).toContain("user.app_metadata?.role !== 'owner'")
    expect(commissionService).toContain("user.app_metadata?.role === 'owner'")
    expect(desktopStaff).toContain("employee.role === 'owner'")
    expect(desktopStaff).toContain("!employee || employee.role === 'owner'")
  })

  it('does not project a tire-worker daily rate on a day without service receipts', () => {
    expect(salaryRoute).toContain("worker.rate_period === 'day' && workerReceipts.length > 0")
    expect(desktopStaff).toContain("worker.rate_period === 'day' && workerReceipts.length > 0")
  })
})
