type Option = { id: string; name: string; phone?: string | null }
const nameKey = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('uk-UA')
const phoneKey = (value: string) => {
  if (!/^\+?[\d\s()-]+$/.test(value.trim())) return ''
  const digits = value.replace(/\D/g, '')
  return /^0\d{9}$/.test(digits) ? `38${digits}` : digits.length >= 10 ? digits : ''
}

/** Unhighlighted Enter may confirm only one exact match in a complete result set. */
export function supplierKeyboardChoice<T extends Option>(rows: readonly T[], query: string, active: number, complete: boolean): T | undefined {
  if (active >= 0 && rows[active]) return rows[active]
  if (!complete || !query.trim()) return undefined
  const name = nameKey(query), phone = phoneKey(query)
  const matches = rows.filter(row => nameKey(row.name) === name || (phone && phoneKey(row.phone ?? '') === phone))
  return matches.length === 1 ? matches[0] : undefined
}
