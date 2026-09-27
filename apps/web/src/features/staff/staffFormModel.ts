export function normalizedStaffPhone(value: string): string {
  const digits = value.replace(/\D/g, '')
  return digits.startsWith('0') ? `38${digits}` : digits.startsWith('80') ? `3${digits}` : digits
}

export function staffTransactionAmount(value: string): number {
  const normalized = value.trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.')
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) throw new Error('Вкажіть коректну суму з точністю до копійок')
  const [whole, fraction = ''] = normalized.split('.')
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Сума має бути більшою за нуль')
  return amount
}

export function staffPaySettings(form: {
  role: string; salaryMode: string; base_rate: string;
  pos_revenue: string; pos_profit: string; order_revenue: string; order_profit: string;
  tire_revenue: string; tire_profit: string;
}) {
  const amount = Number(form.base_rate.replace(',', '.') || 0)
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(Math.round(amount * 100))) throw new Error('Вкажіть коректну ставку')
  const base_rate = form.salaryMode === 'only_pct' ? 0 : Math.round(amount * 100)
  const configs = form.role === 'tire_worker'
    ? [['tire_service', form.tire_revenue, form.tire_profit]]
    : [['pos_sales', form.pos_revenue, form.pos_profit], ['order_sales', form.order_revenue, form.order_profit], ['tire_service', form.tire_revenue, form.tire_profit]]
  const rules = form.salaryMode === 'only_rate' ? [] : configs.map(([rule_type, revenue, profit]) => {
    const pct_from_revenue = Number(revenue.replace(',', '.') || 0)
    const pct_from_profit = Number(profit.replace(',', '.') || 0)
    if ([pct_from_revenue, pct_from_profit].some(value => !Number.isFinite(value) || value < 0 || value > 100)) throw new Error('Відсоток має бути від 0 до 100')
    return { rule_type, pct_from_revenue, pct_from_profit }
  }).filter(rule => rule.pct_from_revenue > 0 || rule.pct_from_profit > 0)
  return { base_rate, rules }
}
