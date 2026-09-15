import { expect, it } from 'vitest'
import { canManageCustomerDiscount, canManageCustomerFinancials, canManageCustomerStatus } from './customerEditPermissions'
it('allows cashier discounts without granting financial administration', () => {
  expect(canManageCustomerDiscount('cashier')).toBe(true)
  expect(canManageCustomerDiscount('cashier', 'cashback')).toBe(false)
  expect(canManageCustomerFinancials('cashier')).toBe(false)
  for (const role of ['owner','admin','manager']) expect(canManageCustomerDiscount(role,'cashback')).toBe(true)
  for (const role of [undefined,'tire_worker','storekeeper']) expect(canManageCustomerDiscount(role)).toBe(false)
})

it('allows cashiers to change customer status without financial administration', () => {
  for (const role of ['cashier', 'owner', 'admin', 'manager']) expect(canManageCustomerStatus(role)).toBe(true)
  for (const role of [undefined, 'tire_worker', 'storekeeper']) expect(canManageCustomerStatus(role)).toBe(false)
  expect(canManageCustomerFinancials('cashier')).toBe(false)
})
