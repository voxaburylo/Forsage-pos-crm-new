// Internal historical calculation, saved with the sale in app_meta and included in full DB backups.
export type CommissionLineBasis = { id: string; quantity_units: number; amount: number }
export type CommissionEmployeeBasis = { employee_id: string; payment_id: string; amount: number; lines: CommissionLineBasis[] }
export type CommissionBasis = { version: 1; tenant_id: string; sale_id: string; employees: CommissionEmployeeBasis[] }

export function commissionBasisKey(tenantId: string, saleId: string): string {
  return 'commission-basis:v1:' + tenantId + ':' + saleId
}

export function parseCommissionBasis(raw: string, tenantId: string, saleId: string): CommissionBasis {
  const message = 'Збережений розрахунок зарплати пошкоджений. Повернення не проведено; потрібна перевірка.'
  try {
    const value = JSON.parse(raw)
    if (value.version !== 1 || value.tenant_id !== tenantId || value.sale_id !== saleId || !Array.isArray(value.employees)) throw Error()
    const employees = new Set<string>()
    for (const employee of value.employees) {
      if (typeof employee.employee_id !== 'string' || !employee.employee_id || employees.has(employee.employee_id)
        || typeof employee.payment_id !== 'string' || !employee.payment_id
        || !Number.isSafeInteger(employee.amount) || employee.amount <= 0 || !Array.isArray(employee.lines)) throw Error()
      employees.add(employee.employee_id)
      const lines = new Set<string>()
      let total = 0
      for (const line of employee.lines) {
        if (typeof line.id !== 'string' || !line.id || lines.has(line.id)
          || !Number.isSafeInteger(line.quantity_units) || line.quantity_units <= 0
          || !Number.isSafeInteger(line.amount) || line.amount < 0) throw Error()
        lines.add(line.id); total += line.amount
      }
      if (!Number.isSafeInteger(total) || total !== employee.amount) throw Error()
    }
    return value as CommissionBasis
  } catch { throw new Error(message) }
}

// Round the cumulative share, not each separate return. This preserves the last kopeck.
export function returnedCommission(amount: number, returnedUnits: number, soldUnits: number): number {
  if (![amount, returnedUnits, soldUnits].every(Number.isSafeInteger) || amount < 0
    || returnedUnits < 0 || soldUnits <= 0 || returnedUnits > soldUnits) throw new Error('Некоректна кількість для сторно зарплати')
  return Number((BigInt(amount) * BigInt(returnedUnits) * 2n + BigInt(soldUnits)) / (BigInt(soldUnits) * 2n))
}
