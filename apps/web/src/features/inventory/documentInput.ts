export function stockQuantity(value: string): number | null {
  const text = value.trim().replace(',', '.')
  if (!/^\d+(\.\d{1,3})?$/.test(text)) return null
  const number = Number(text)
  return Number.isFinite(number) && number > 0 ? number : null
}

export function shiftMonthKey(month: string, delta: number): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !Number.isInteger(delta)) throw new Error('Некоректний місяць')
  const [year, index] = month.split('-').map(Number)
  return new Date(Date.UTC(year, index - 1 + delta, 15)).toISOString().slice(0, 7)
}
