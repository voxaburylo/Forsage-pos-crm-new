import type { Customer } from '@/types/customer'
import { buildRoleSafeCustomerUpdate, canEditCustomerCard, canManageCustomerDiscount, canManageCustomerFinancials, canManageCustomerStatus } from './customerEditPermissions'
import { parseCustomerMoney } from './customerUi'

export function customerEditorValues(customer: Partial<Customer>) {
  return {
    phone: customer.phone ?? '', full_name: customer.full_name ?? '', email: customer.email ?? '',
    birth_date: (customer.birth_date ?? '').slice(0, 10), card_barcode: customer.card_barcode ?? '',
    notes: customer.notes ?? '', tags: [...(customer.tags ?? [])],
    discount_pct: String(customer.discount_pct ?? 0), bonus_balance: ((customer.bonus_balance ?? 0) / 100).toFixed(2),
    client_status: customer.client_status ?? 'client', loyalty_mode: customer.loyalty_mode ?? 'discount',
    price_tier_id: customer.price_tier_id ?? '', vip_level: customer.vip_level ?? 'standard', risk_profile: customer.risk_profile ?? 'low',
  }
}

export type CustomerEditorValues = ReturnType<typeof customerEditorValues>

/** Both the in-page card and contextual editor use the same fields and permissions. */
export function customerEditorUpdate(current: Customer, form: CustomerEditorValues, role: string | undefined) {
  if (!canEditCustomerCard(role)) throw new Error('Немає дозволу змінювати картку клієнта')
  if (!form.phone.trim()) throw new Error("Телефон обов'язковий")
  const canManageFinancials = canManageCustomerFinancials(role)
  // A cashier cannot gain permission by changing the draft's loyalty mode.
  const canManageDiscount = canManageCustomerDiscount(role, current.loyalty_mode ?? 'discount')
  const discount = Number(form.discount_pct.replace(',', '.'))
  const bonus = parseCustomerMoney(form.bonus_balance)
  if (canManageFinancials && bonus === null) throw new Error('Некоректний баланс бонусів')
  if (canManageDiscount && (!Number.isFinite(discount) || discount < 0 || discount > 100)) throw new Error('Знижка має бути від 0 до 100%')
  const update = buildRoleSafeCustomerUpdate(role, {
    phone: form.phone.trim(), full_name: form.full_name.trim(), email: form.email.trim(), birth_date: form.birth_date || null,
    card_barcode: form.card_barcode.replace(/\s/g, '') || null, notes: form.notes.trim(), tags: [...form.tags],
  }, {
    loyalty_mode: form.loyalty_mode, price_tier_id: form.price_tier_id || null,
    vip_level: form.vip_level, risk_profile: form.risk_profile,
  })
  return {
    ...update,
    ...(canManageCustomerStatus(role) ? { client_status: form.client_status } : {}),
    ...(canManageDiscount ? { discount_pct: discount } : {}),
    expected_updated_at: current.updated_at,
    ...(canManageFinancials && bonus !== null && bonus !== current.bonus_balance
      ? { bonus_balance: bonus, expected_bonus_balance: current.bonus_balance, bonus_description: 'Ручне коригування у картці клієнта' }
      : {}),
  }
}
