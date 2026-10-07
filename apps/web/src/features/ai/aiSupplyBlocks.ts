import { assertSupplyAnnotation } from './aiSupplySourceGuard'
import { readSupplySummary, type SupplySummary } from './aiSupplySummary'

/** Explicit numbered product descriptions copied from chat/email; no inference from sizes or retail prices. */
export function readSupplyBlocks(text: string): { rows: Record<string, unknown>[]; currencyText: string; summaries: SupplySummary[] } | null {
  const lines = text.split(/\r?\n/).map(line => line.trim().replace(/\*\*/g, ''))
  const title = /^(\d+(?:\uFE0F?\u20E3|[.)]))\s+(.+)$/
  const quantity = /^(?:кількість|количество|кол[ -]?во|qty)\s*:\s*(.*)$/i
  const buying = /^(?:закупівля|закупка|закупівельна ціна|закупочная цена|ціна закупівлі|ціна закупки|цена закупки|purchase price)\s*:\s*(.*)$/i
  if (!lines.some(line => title.test(line)) || !lines.some(line => quantity.test(line)) || !lines.some(line => buying.test(line))) return null
  const blocks: { number:number; name:string; lines:string[] }[] = []
  for (const line of lines) {
    if (!line) continue
    const heading = line.match(title)
    if (heading) {
      const number = Number(heading[1].replace(/[^0-9]/g, ''))
      blocks.push({ number, name:heading[2].trim(), lines:[] })
    } else if (blocks.length) blocks[blocks.length-1].lines.push(line)
    else if (!/^(?:товари|товары|список товарів|список товаров|накладна|накладная)\s*:?$/i.test(line)) return null
  }
  const currencyLines: string[] = []
  const summaries: SupplySummary[] = []
  const currencies = new Set<string>()
  const rows = blocks.map((block,index) => {
    const location = 'Товар ' + (index+1)
    if (block.number !== index+1) throw Error(location + ': порушена нумерація списку. Перевірте, чи всі товари скопійовано.')
    const quantities = block.lines.flatMap(line=>{const match=line.match(quantity);return match?[match[1]]:[]})
    const prices = block.lines.flatMap(line=>{const match=line.match(buying);return match?[match[1]]:[]})
    if (quantities.length !== 1 || prices.length !== 1) throw Error(location + ': потрібні по одному полю «Кількість» і «Закупівля». Товари не пропущено.')
    const summaryLines = new Set<string>()
    for (const line of block.lines) {
      const summary = readSupplySummary([line], index + 1, location)
      if (summary) { summaries.push(summary); summaryLines.add(line); currencyLines.push(line); continue }
      const separator = line.indexOf(':')
      if (separator >= 0) assertSupplyAnnotation(line.slice(0,separator), line.slice(separator+1), location)
    }
    const rawQty = quantities[0], rawPrice = prices[0]
    const unitMatch = rawQty.match(/\s*(шт|кг|л|м|компл)\.?$/i)
    const unit = unitMatch?.[1].toLowerCase() ?? 'шт'
    const priceUnit = rawPrice.match(/(?:\/|\sза\s+)\s*(шт|кг|л|м|компл)\.?$/i)
    if (priceUnit && priceUnit[1].toLowerCase() !== unit) throw Error(location + ': одиниця закупівельної ціни не збігається з одиницею кількості.')
    const perUnitRemoved = priceUnit ? rawPrice.slice(0, priceUnit.index).trim() : rawPrice
    const approximate = /^(?:приблизно|орієнтовно|около|примерно|~|≈)\s*/i.exec(perUnitRemoved)
    const numericPrice = perUnitRemoved.slice(approximate?.[0].length ?? 0).replace(/\s*(?:грн\.?|uah|₴|usd|\$|eur|€|pln)\s*$/i,'')
    currencyLines.push('Закупівля: '+rawPrice)
    currencies.add(/USD|\$/i.test(rawPrice) ? 'USD' : /EUR|€/i.test(rawPrice) ? 'EUR' : /PLN/i.test(rawPrice) ? 'PLN' : 'UAH')
    const description = block.lines.filter(line=>!summaryLines.has(line)&&!quantity.test(line)&&!buying.test(line)&&!/^(?:ціна продажу|цена продажи|продаж|роздріб|розница)\s*:/i.test(line))
    const row: Record<string,unknown> = {
      name:block.name, source_name:[block.name,...description].join(' '), unit,
      qty:rawQty, purchase_price_uah:numericPrice,
    }
    for (const [field,pattern] of [
      ['sku',/^(?:артикул|sku)\s*:\s*(.*)$/i],
      ['barcode',/^(?:штрихкод|штрих код|barcode)\s*:\s*(.*)$/i],
      ['brand',/^(?:бренд|виробник|brand)\s*:\s*(.*)$/i],
      ['category_name',/^(?:категорія|категория|папка)\s*:\s*(.*)$/i],
    ] as const) {
      const values = block.lines.flatMap(line=>{const match=line.match(pattern);return match?[match[1]]:[]})
      if (values.length>1) throw Error(location + ': поле «'+field+'» повторюється. Перевірте текст.')
      if(values[0]) row[field]=values[0]
    }
    if (approximate) row.purchase_price_note='У джерелі закупівля орієнтовна: '+rawPrice+'. Перевірте точну ціну в чернетці перед проведенням.'
    return row
  })
  if (currencies.size > 1) throw Error('У списку кілька валют закупівлі. Розділіть товари за валютою, щоб не змішати ціни.')
  return {rows,summaries,currencyText:currencyLines.join('\n')}
}
