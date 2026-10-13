import { useId } from 'react'
import { Input } from '@/components/ui'
import { canManageCustomerDiscount, canManageCustomerFinancials } from './customerEditPermissions'
import type { CustomerLoyaltyMode } from './customerCreateModel'

interface Props {
  role?: string | null
  mode: CustomerLoyaltyMode
  discount: string
  tierId: string
  tiers: { id: string; name: string; discount_pct: number }[]
  onModeChange: (mode: CustomerLoyaltyMode) => void
  onDiscountChange: (value: string) => void
  onTierChange: (value: string) => void
}

export function CustomerCreationLoyaltyFields({ role, mode, discount, tierId, tiers, onModeChange, onDiscountChange, onTierChange }: Props) {
  const id = useId()
  const canManageFinancials = canManageCustomerFinancials(role)
  const effectiveMode = canManageFinancials ? mode : 'discount'
  const tier = canManageFinancials ? tiers.find((item) => item.id === tierId) : undefined
  return <div className="space-y-3">
    <div className="grid gap-3 sm:grid-cols-2">
      {canManageFinancials && <div>
        <label htmlFor={`${id}-mode`} className="mb-1 block text-sm font-medium text-gray-700">Процент працює як</label>
        <select id={`${id}-mode`} value={effectiveMode} onChange={(e) => onModeChange(e.target.value as CustomerLoyaltyMode)} className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm">
          <option value="discount">Знижка в касі</option>
          <option value="cashback">Накопичення на рахунок</option>
        </select>
      </div>}
      <Input id={`${id}-percentage`} label={effectiveMode === 'cashback' ? 'Накопичення (%)' : 'Персональна знижка (%)'} disabled={!canManageCustomerDiscount(role)} type="number" min="0" max="100" step="any" value={discount} onChange={(e) => onDiscountChange(e.target.value)} />
    </div>
    {canManageFinancials && tiers.length > 0 && <div>
      <label htmlFor={`${id}-tier`} className="mb-1 block text-sm font-medium text-gray-700">Ціновий рівень</label>
      <select id={`${id}-tier`} value={tierId} onChange={(e) => onTierChange(e.target.value)} className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm">
        <option value="">{effectiveMode === 'cashback' ? 'Персональний відсоток з картки' : 'Персональна знижка з картки'}</option>
        {tiers.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.discount_pct}%)</option>)}
      </select>
    </div>}
    <p className="text-sm text-gray-600">{effectiveMode === 'cashback'
      ? 'Ціна в чеку не зменшується: накопичення зараховується на рахунок клієнта. Бонуси — окремий баланс.'
      : tier
        ? `У касі діє знижка цінової групи «${tier.name}» — ${tier.discount_pct}%. Для персональної знижки виберіть її у списку вище.`
        : 'У касі діє персональна знижка з цієї картки. Вона зменшує ціну, а не накопичує кошти.'}</p>
    {!canManageFinancials && <p className="text-xs text-gray-500">Режим накопичення, ціновий рівень і бонусний баланс змінює власник, адміністратор або менеджер. Персональна знижка картки не надає права на ручну знижку в чеку.</p>}
  </div>
}
