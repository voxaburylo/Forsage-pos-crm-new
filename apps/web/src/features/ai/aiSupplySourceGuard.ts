/** Source-only checks: never infer tax, discounts or units from a product name. */
const labelText = (value: unknown) => String(value ?? '').normalize('NFKC').toLocaleLowerCase('uk-UA').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim()
const pack = /упаков|пакув|короб|ящик|пачк|(?:^|[\s,/(])(?:уп|упак|pack(?:age)?s?|boxes|box)(?:$|[\s.,%)/])/u
const retail = /продаж|роздр|рознич|retail|sale|sell/
const tax = /пдв|ндс|\bvat\b|\btax\b/
const includedTax = /^(?:у тому числі|в тому числі|в т\s*ч|включно|включен[оа]?|including|included|incl)\s/
const noEffect = (value: unknown) => /^(?:|[-—–]|0+(?:[.,]0+)?\s*(?:%|грн\.?|uah|₴)?|без пдв|без ндс|no vat|no tax)$/i.test(String(value ?? '').trim())

export function assertSupplyCurrency(value: unknown, location: string): void {
  const text = String(value ?? '').trim()
  if (!text) return
  if (!/^(?:UAH|грн\.?|₴|гривн[аяіи]|USD|\$|долар[иі]?|доллар[ыа]?|EUR|€|євро|евро|PLN|злот[иі])$/i.test(text)) {
    throw new Error(location + ': не вдалося однозначно визначити валюту закупівлі. Вкажіть UAH, USD, EUR або PLN; невідому валюту не замінено на гривні.')
  }
}

export function assertSupplyPriceHeader(value: unknown, location: string): void {
  const label = labelText(value)
  if (pack.test(label) || /(?:без|excl(?:uding)?|without)\s*(?:пдв|ндс|vat|tax)|(?:до|перед|before|pre)\s*(?:зниж|скид|discount)/u.test(label)) {
    throw new Error(location + ': вкажіть кінцеву закупівельну ціну за одиницю товару після знижок і з потрібним ПДВ. Ціна за упаковку або до коригувань не перераховується автоматично.')
  }
}

export function assertSupplyQuantityHeader(value: unknown, location: string): void {
  if (pack.test(labelText(value))) throw new Error(location + ': кількість упаковок не є кількістю товару. Вкажіть кількість та закупівельну ціну в одиницях обліку; упаковки не перераховано автоматично.')
}

/** Inspect only column labels or separate metadata lines, not arbitrary descriptions. */
export function assertSupplyAnnotation(labelValue: unknown, value: unknown, location: string, priceHeader: unknown = ''): void {
  const label = labelText(labelValue)
  if (retail.test(label) || noEffect(value)) return
  const finalPrice = labelText(priceHeader)
  if (/зниж|скид|discount/.test(label) && /(?:після|после|after)\s*(?:зниж|скид|discount)/.test(finalPrice)) return
  if (tax.test(label) && /(?:^|\s)(?:з|с|with|incl(?:uding)?)\s*(?:пдв|ндс|vat|tax)/.test(finalPrice)) return
  if (/зниж|скид|discount/.test(label)) throw new Error(location + ': окрема знижка потребує перевірки. Вкажіть кінцеву закупівельну ціну за одиницю після знижки; суму не змінено автоматично.')
  if (tax.test(label) && !includedTax.test(label) && !/^(?:без пдв|без ндс|no vat|no tax)$/.test(label)) {
    throw new Error(location + ': окремий ПДВ потребує перевірки. Вкажіть кінцеву закупівельну ціну за одиницю; ПДВ не додано й не відкинуто автоматично.')
  }
  if (pack.test(label) || /коефіцієнт|коэффициент|conversion factor/.test(label)) throw new Error(location + ': перевірте кількість в упаковці та одиницю обліку. Упаковки не перераховано автоматично.')
}

const canonicalUnit = (value: string) => {
  const clean = value.trim().toLocaleLowerCase('uk-UA').replace(/\.$/, '')
  const aliases: Record<string,string> = { pc:'шт',pcs:'шт',штук:'шт',штука:'шт',kg:'кг',кілограм:'кг',килограмм:'кг',l:'л',літр:'л',литр:'л',m:'м',метр:'м',комплект:'компл' }
  return aliases[clean] ?? clean
}
export function supplyValueUnit(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLocaleLowerCase('uk-UA')
  const found = text.match(/(?:^|[^\p{L}])(шт|кг|л|м|компл|pcs?|kg|l|m)\.?\s*$/u)?.[1]
  return found ? canonicalUnit(found) : undefined
}

export function supplyRowUnit(quantityHeader: unknown, quantity: unknown, priceHeader: unknown, explicit: string | undefined, location: string): string | undefined {
  const qtyUnits = [supplyValueUnit(quantityHeader), supplyValueUnit(quantity), explicit ? canonicalUnit(explicit) : undefined].filter((value): value is string => !!value)
  const units = new Set(qtyUnits)
  const priceUnit = supplyValueUnit(priceHeader)
  if (units.size > 1 || (priceUnit && priceUnit !== (qtyUnits[0] ?? 'шт'))) {
    throw new Error(location + ': одиниця кількості, ціни та товару не збігається. Перерахунок не виконано.')
  }
  return qtyUnits[0]
}
