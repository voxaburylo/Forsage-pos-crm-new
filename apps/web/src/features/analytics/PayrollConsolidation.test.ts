import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const staff = source('../staff/StaffPage.tsx')
const payroll = source('./PayrollPage.tsx')
function methodCalls(text: string, object: string): string[] {
  const file = ts.createSourceFile('page.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const calls: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(file) === object) calls.push(node.expression.name.text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return calls
}

describe('salary has one mutation surface, with the previous safety contracts', () => {
  it('Staff retains employment settings but never sends salary writes', () => {
    expect(methodCalls(staff, 'staffApi')).toEqual(['summary', 'dailySummary'])
    expect(methodCalls(staff, 'adminApi')).toEqual(expect.arrayContaining(['saveUserSettings', 'createUser', 'resetPassword', 'deleteUser', 'restoreUser']))
    expect(staff).toContain('/analytics/payroll?employee=${encodeURIComponent(selectedUser.id)}&period=${encodeURIComponent(period)}')
    expect(staff).not.toContain('modalTab')
  })
  it('Payroll is the only salary write surface and keeps the awaited shift preflight', () => {
    const calls = methodCalls(payroll, 'staffApi')
    for (const name of ['createSalary', 'dailyPayout', 'deleteSalary']) expect(calls.filter(call => call === name)).toHaveLength(1)
    expect(payroll).toContain("form.type === 'advance' && form.method === 'cash'")
    expect(payroll).toContain('await currentShiftId()')
    expect(payroll.match(/const workDate = localDate\(\)/g)).toHaveLength(3)
    expect(payroll.match(/loadedDailyDate !== workDate/g)).toHaveLength(2)
    expect(payroll.match(/work_date: workDate/g)).toHaveLength(2)
  })
  it('preserves inactive employees, validates the month and only opens employees from the authorized list', () => {
    expect(payroll).toContain('adminApi.listUsers(true)')
    expect(payroll).toContain("!user.deleted_at && user.role !== 'owner'")
    expect(payroll).toContain('users.find(user => user.id === requestedEmployee)')
    expect(payroll).toContain('setRequestedEmployee(null)')
    expect(payroll).toContain('aria-label="Місяць зарплати"')
    expect(payroll).toContain("/^\\d{4}-(0[1-9]|1[0-2])$/")
    expect(payroll).toContain('/analytics/sales?tab=tire&employee=')
  })
  it('keeps read-only web controls and uses the shared unsaved-change guard', () => {
    expect(payroll).toContain('const canWrite = isDesktopRuntime()')
    expect(payroll).toContain('if (!selected || !canWrite || !ready')
    expect(payroll).toContain('useUnsavedChanges(')
    expect(staff).toContain('useUnsavedChanges(')
  })
  it('preserves signed balance effects and never changes the stored amounts to render history', () => {
    expect(payroll).toContain("payment.type === 'advance' || payment.type === 'penalty' ? -payment.amount : payment.amount")
    expect(payroll).toContain('formatMoney(Math.abs(effect))')
    expect(payroll).toContain('formatBusinessDateTime(payment.created_at)')
    expect(payroll).toContain('payrollOperationLabel(payment)')
    expect(payroll).not.toMatch(/payment\.amount\s*=(?!=)/)
  })
})
