/** Strict source numbers. Whitespace is a thousands separator, never arbitrary glue. */
export function readSupplyNumber(value: unknown, kind: 'qty' | 'price', location: string): number {
  const label = kind === 'qty' ? 'кількість' : 'закупівельну ціну'
  const invalid = () => new Error(location + ': перевірте ' + label + ' «' + String(value ?? '').slice(0,50) + '». Значення не підмінено.')
  if (typeof value !== 'string' && typeof value !== 'number') throw invalid()
  let s = String(value).replace(/[\u00a0\u202f]/g,' ').trim()
  s = (kind === 'price' ? s.replace(/(?:грн\.?|uah|₴)$/i,'') : s.replace(/(?:шт\.?|кг|компл\.?|л|м)$/i,'')).trim()
  if (/\s/.test(s)) {
    if (!/^\d{1,3}(?: \d{3})+(?:[.,]\d+)?$/.test(s)) throw invalid()
    s = s.replace(/ /g,'')
  }
  if (s.includes('.') && s.includes(',')) {
    const last = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ','
    const group = last === '.' ? ',' : '.'
    const escaped = group === '.' ? '\\.' : ','
    if (!new RegExp('^\\d{1,3}(?:'+escaped+'\\d{3})+[.,]\\d{1,3}$').test(s)) throw invalid()
    s = s.split(group).join('').replace(',','.')
  } else s = s.replace(',','.')
  const digits = kind === 'qty' ? 3 : 2
  const n = Number(s)
  if (!new RegExp('^\\d+(?:\\.\\d{1,'+digits+'})?$').test(s) || !Number.isFinite(n)
    || (kind === 'qty' ? n <= 0 : n < 0) || n > (kind === 'qty' ? 1_000_000 : 21_474_836.47)) throw invalid()
  return n
}

export function supplyNumberAliases(raw: Record<string, unknown>, keys: string[], kind: 'qty' | 'price', location: string): number {
  const values = keys.filter(key => raw[key] !== undefined && raw[key] !== null).map(key => readSupplyNumber(raw[key],kind,location))
  if (!values.length) return readSupplyNumber(undefined,kind,location)
  if (values.some(value => value !== values[0])) throw new Error(location + ': суперечливі значення ' + (kind === 'qty' ? 'кількості' : 'закупівлі') + '. Уточніть джерело.')
  return values[0]
}

/** Compare kopecks using integer arithmetic. No automatic corrections. */
export function assertSupplyLineTotal(qty: number, price: number, total: unknown, location: string): void {
  const stated = readSupplyNumber(total,'price',location)
  const expected = (BigInt(Math.round(qty*1000)) * BigInt(Math.round(price*100)) + 500n) / 1000n
  if (expected !== BigInt(Math.round(stated*100)))
    throw new Error(location + ': кількість × закупівля не збігається із сумою рядка. Перевірте ціну, знижку та ПДВ; числа не виправлено автоматично.')
}
