import type { Customer } from '@/types/customer'
import { formatMoney } from '@/lib/utils'

export function CustomerBalances({ customer, deposit }: { customer: Customer; deposit?: number | null }) {
  const account = deposit ?? customer.deposit_balance
  const values = [
    { label: 'Клієнт винен магазину', value: customer.debt_balance, color: 'text-red-700', hint: 'Борг за неоплачені покупки.' },
    { label: 'Кошти клієнта', value: account, color: 'text-emerald-700', hint: 'Доступні для оплати або повернення через касу.' },
    { label: 'Бонуси', value: customer.bonus_balance, color: 'text-amber-700', hint: 'Окремий бонусний баланс, не готівка.' },
  ]
  return <div>
    <div className="grid gap-3 sm:grid-cols-3">
      {values.map((item) => <div key={item.label} className="rounded-xl border border-gray-200 bg-white p-3">
        <p className="text-xs font-medium text-gray-600">{item.label}</p>
        <p className={`mt-1 text-xl font-bold ${item.color}`}>{item.value == null ? 'Не завантажено' : formatMoney(item.value)}</p>
        <p className="mt-1 text-xs text-gray-500">{item.hint}</p>
      </div>)}
    </div>
    <p className="mt-2 text-xs text-gray-500">Передоплати за чинними замовленнями показані в самих замовленнях. Вони не додаються вдруге до коштів клієнта. Борг, кошти та бонуси не взаємозаліковуються автоматично.</p>
  </div>
}
