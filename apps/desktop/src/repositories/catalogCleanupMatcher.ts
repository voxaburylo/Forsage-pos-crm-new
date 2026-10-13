import { createHash } from 'node:crypto'

/** Read-only evidence, never authority to merge stock, documents, prices or customer history. */
export interface CleanupProduct {
  id: string; name: string; sku: string | null; barcode: string | null;
  additional_barcodes?: string[] | null; brand: string | null; brand_id?: string | null;
  unit: string; qty_on_hand: number; purchase_price: number; retail_price: number; created_at?: string | null;
}
export interface CleanupGroup {
  id: string; level: 'exact' | 'review' | 'conflict'; reasons: string[]; conflicts: string[];
  product_ids: string[]; suggested_target_id: string;
}
export interface CleanupSkuSuggestion { product_id: string; sku: string; evidence: string; blocked?: string }
export interface CatalogCleanupAnalysis {
  groups: CleanupGroup[]; sku_suggestions: CleanupSkuSuggestion[]; warnings: string[];
  stats: { products: number; candidate_pairs: number; skipped_large_blocks: number };
}
const MAX_BLOCK = 80, MAX_PAIRS = 120_000, MAX_GROUP = 24
const text = (s: string | null | undefined) => String(s ?? '').normalize('NFKC').toLocaleLowerCase('uk').replace(/[’'`]/g, '').replace(/[–—−]/g, '-').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
const code = (s: string | null | undefined) => text(s).toUpperCase().replace(/[^\p{L}\p{N}]/gu, '')
const unique = (items: string[]) => [...new Set(items)].sort()
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const equal = (a: string[], b: string[]) => a.join('\0') === b.join('\0')
const overlap = (a: string[], b: string[]) => a.some(value => b.includes(value))
const stableId = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
const UNIT_ALIASES: Record<string, string> = { mm: 'мм', cm: 'см', ml: 'мл', l: 'л', kg: 'кг', g: 'г', m: 'м', pcs: 'шт', v: 'в', w: 'вт', ah: 'ач', штука: 'шт', штуки: 'шт', штук: 'шт', piece: 'шт', 'к-т': 'комплект', компл: 'комплект', комп: 'комплект', kit: 'комплект' }
const unit = (value: string) => { const clean = text(value).replace(/\.$/, ''); return UNIT_ALIASES[clean] ?? clean }
const WORDS: Record<string, string> = {
  подкачка: 'підкачка', подкачки: 'підкачка', підкачки: 'підкачка', подкачивающая: 'підкачка',
  фильтр: 'фільтр', топливный: 'паливний', топливний: 'паливний', топливная: 'паливний', паливна: 'паливний', топлива: 'паливний',
  воздушный: 'повітряний', воздушная: 'повітряний', масляный: 'оливний', масляний: 'оливний', масляна: 'оливний',
  масло: 'олива', масла: 'олива', мастило: 'олива', моторное: 'моторна', моторна: 'моторна', моторная: 'моторна', трансмиссионное: 'трансмісійна',
  синтетическое: 'синтетична', синтетическая: 'синтетична', синтетичне: 'синтетична',
  ремень: 'ремінь', приводной: 'привідний', приводний: 'привідний', генератора: 'генератор',
  подшипник: 'підшипник', ступицы: 'ступиця', ступиці: 'ступиця', задний: 'задній', передний: 'передній',
  радиатор: 'радіатор', кондиционера: 'кондиціонер', кондиціонера: 'кондиціонер', охлаждения: 'охолодження',
  клемма: 'клема', аккумулятора: 'акумулятор', акумулятора: 'акумулятор', аккумулятор: 'акумулятор', акб: 'акумулятор',
  колеса: 'колесо', колесный: 'колісний', колісна: 'колісний', колесная: 'колісний',
  суппорта: 'супорт', супорта: 'супорт', тормозной: 'гальмівний', тормозная: 'гальмівний', гальмівна: 'гальмівний',
  насос: 'насос', водяной: 'водяний', водяная: 'водяний', свеча: 'свічка', зажигания: 'запалювання',
  бачка: 'бачок', расширительного: 'розширювальний', патрубок: 'патрубок', шланг: 'шланг',
}
const STOP = new Set(['для', 'та', 'і', 'и', 'с', 'з', 'в', 'на', 'до', 'із', 'арт', 'артикул', 'кат', 'каталожний', 'каталожный', 'номер', 'код', 'товару', 'товара'])
const KINDS = new Set(['груша', 'фільтр', 'олива', 'амортизатор', 'помпа', 'насос', 'радіатор', 'ремінь', 'гайка', 'болт', 'шланг', 'патрубок', 'акумулятор', 'клема', 'лампа', 'підшипник', 'ремкомплект', 'датчик', 'свічка', 'резонатор', 'прокладка', 'глушник'])
const BRAND_ALIASES: Record<string, string> = {
  balaton: 'balaton', балатон: 'balaton', mannol: 'mannol', маннол: 'mannol', bosch: 'bosch', бош: 'bosch',
  wix: 'wix', вікс: 'wix', викс: 'wix', hort: 'hort', хорт: 'hort', elf: 'elf', ельф: 'elf', эльф: 'elf',
  polmo: 'polmo', полмо: 'polmo', euroex: 'euroex', євроекс: 'euroex', crb: 'crb', febi: 'febi',
  ssd: 'ssd', brt: 'brt', брт: 'brt', hoco: 'hoco', polo: 'polo', поло: 'polo', mobil: 'mobil', shell: 'shell',
}
function brand(value: string | null | undefined) {
  const key = code(value).toLowerCase()
  return ['безбренду', 'невідомо', 'unknown', 'noname'].includes(key) ? '' : BRAND_ALIASES[key] ?? key
}
function technicalCode(value: string) {
  const clean = code(value)
  return /^(?:\d+(?:W\d+|ML|L|KG|MM|CM|V|W|AH|A|H)|[MGH]\d{1,3}|[A-Z]\d{1,2}[A-Z]\d|[A-Z]\d[A-Z]{1,2}|(?:VAZ|ВАЗ|GAZ|ГАЗ|ЗАЗ|ЗИЛ|BMW|AUDI)\d+)$/i.test(clean)
    || /^\d+[xх]\d/i.test(value) || /^m\d+[xх]/i.test(value) || /^\d+\/\d+[rр]?\d+$/i.test(value)
    || /^\d{4}-\d{4}$/.test(value)
}
interface Article { raw: string; key: string; explicit: boolean }
/** Deliberately narrower than skuFromName: bare engine/models and specifications are not articles. */
function articles(name: string): Article[] {
  const result: Article[] = []
  const add = (raw: string, explicit: boolean) => {
    const key = code(raw)
    if (!/\d/.test(key) || key.length < 4 || key.length > 32 || technicalCode(raw)) return
    if (!explicit && !( /^[A-Z]{1,4}[-._/]?\d[A-Z0-9/._-]{3,}$/i.test(raw) || /^\d{4,}[-/](?:\d+|[A-Z][A-Z0-9-]{2,})$/i.test(raw) || /^[A-Z]{1,3}[-/][A-Z0-9-]{4,}$/i.test(raw))) return
    if (!explicit && /[\p{L}]/u.test(raw) && !/[A-Z]/i.test(raw)) return
    const existing = result.find(item => item.key === key)
    if (existing) existing.explicit ||= explicit
    else result.push({ raw, key, explicit })
  }
  for (const match of name.matchAll(/(?<![\p{L}\p{N}])(?:арт(?:икул)?|кат(?:аложний|аложный)?(?:\s+номер)?|код(?:\s+товару|\s+товара)?)\s*[.:№#-]?\s*([\p{L}\p{N}][\p{L}\p{N}/._-]{2,30})/giu)) add(match[1], true)
  for (const match of name.matchAll(/[\p{L}\p{N}][\p{L}\p{N}/._-]*[\p{L}\p{N}]/gu)) add(match[0], false)
  return result.slice(0, 8)
}
function barcodes(p: CleanupProduct) {
  return unique([p.barcode, ...(p.additional_barcodes ?? [])].filter((value): value is string => Boolean(value?.trim())).map(value => /^\s*[\d\s]+\s*$/.test(value) ? value.replace(/\s/g, '') : value.trim()))
}
interface Features {
  product: CleanupProduct; core: string[]; kind: string; technical: string[]; dimensions: string[]; unknownUnits: string[];
  shapes: string[]; colors: string[]; polarity: string[]; brands: string[]; brandConflict: boolean; unit: string;
  fieldSku: string; codes: string[]; barcodes: string[]; articles: Article[]; nameKey: string;
}
function prepare(p: CleanupProduct, brands: Map<string, string>): Features {
  let remaining = text(p.name).replace(/(?<![\p{L}\p{N}])(\d+)w[-\s]?(\d+)(?![\p{L}\p{N}])/gu, '$1w$2')
  const foundBrands: string[] = [], tokens = remaining.replace(/(\p{L})(\d)|(\d)(\p{L})/gu, '$1$3 $2$4').match(/[\p{L}\p{N}]+/gu) ?? []
  for (let index = 0; index < tokens.length; index++) for (let length = 1; length <= 4 && index + length <= tokens.length; length++) {
    const words = tokens.slice(index, index + length), key = words.join(''), found = brands.get(key)
    if (!found) continue
    foundBrands.push(found)
    remaining = remaining.replace(new RegExp('(?<![\\p{L}])' + words.map(escape).join('[\\s.-]*') + '(?![\\p{L}])', 'giu'), ' ')
  }
  const fieldBrand = brand(p.brand), namedBrands = unique(foundBrands)
  const allBrands = unique([...namedBrands, ...(fieldBrand ? [fieldBrand] : [])])
  const candidates = articles(p.name), fieldSku = /^AUTO[-_]/i.test(p.sku ?? '') ? '' : code(p.sku)
  const codes = unique([...(fieldSku.length >= 4 && /\d/.test(fieldSku) ? [fieldSku] : []), ...candidates.map(item => item.key)])
  for (const item of [...candidates.map(item => item.raw), ...(p.sku && fieldSku.length >= 4 && !technicalCode(p.sku) ? [p.sku] : [])]) {
    const key = code(item)
    remaining = remaining.replace(new RegExp('(?<![\\p{L}\\p{N}])' + [...key].map(escape).join('[\\s./_-]*') + '(?![\\p{L}\\p{N}])', 'giu'), ' ')
  }
  const dimensions: string[] = []
  remaining = remaining.replace(/(\d+(?:[.,]\d+)?(?:[\/xх×]\d+(?:[.,]\d+)?)*)\s*(мм|mm|см|cm|мл|ml|кг|kg|шт|pcs|вт|ah|ач|л|l|г|g|м|m|в|v|w)(?![\p{L}\p{N}])/giu, (_, amount: string, measure: string) => {
    dimensions.push(amount.replace(/,/g, '.').replace(/[х×]/g, 'x') + ':' + unit(measure)); return ' '
  })
  const unknownUnits = unique([...remaining.matchAll(/(\d+(?:[.,]\d+)?)([\p{L}]{1,8})(?![\p{L}\p{N}])/gu)].map(match => match[1] + match[2]))
  const extract = (pattern: RegExp, canonical: (match: string) => string) => {
    const values: string[] = []
    remaining = remaining.replace(pattern, match => { values.push(canonical(match)); return ' ' })
    return unique(values)
  }
  const shapes = extract(/(?<![\p{L}\p{N}])(?:[гgl]-?\s*(?:образн[\p{L}]*|подібн[\p{L}]*)|прям(?:ий|а|ой|ая|е|ий))(?![\p{L}])/gu, match => /^прям/u.test(match) ? 'пряма' : /^[гg]/u.test(match) ? 'г-подібна' : 'l-подібна')
  const colors = extract(/(?<![\p{L}])(?:чорн(?:ий|а|е|і)|черн(?:ый|ая|ое|ые)|хром|хромован(?:ий|а|е|і)|хромированн(?:ый|ая|ое|ые)|біл(?:ий|а|е|і)|бел(?:ый|ая|ое|ые)|син(?:ій|я|є|і|ий|яя|ее|ие)|червон(?:ий|а|е|і)|красн(?:ый|ая|ое|ые)|жовт(?:ий|а|е|і)|желт(?:ый|ая|ое|ые)|зелен(?:ий|а|е|і|ый|ая|ое|ые)|black|chrome|white|blue|red|yellow|green)(?![\p{L}])/gu, match => /^(?:чорн|черн|black)/u.test(match) ? 'чорний' : /^(?:хром|chrome)/u.test(match) ? 'хром' : /^(?:біл|бел|white)/u.test(match) ? 'білий' : /^(?:син|blue)/u.test(match) ? 'синій' : /^(?:червон|красн|red)/u.test(match) ? 'червоний' : /^(?:жовт|желт|yellow)/u.test(match) ? 'жовтий' : 'зелений')
  const polarity = extract(/(?<![\p{L}\p{N}])(?:плюс|мінус|минус|[+-])(?=$|[^\p{L}\p{N}])|(?<=[\p{L}])[+-](?=$|[\s)])/gu, match => match === '+' || match === 'плюс' ? '+' : '-')
  const rawTokens = remaining.match(/[+-]?[\p{L}\p{N}]+(?:[.,/-][\p{L}\p{N}]+)*/gu) ?? []
  const words = rawTokens.filter(token => !/\d/.test(token)).map(token => WORDS[token] ?? token).filter(token => !STOP.has(token))
  const core = unique(words), technical = unique(rawTokens.filter(token => /\d/.test(token)).map(token => token.replace(/,/g, '.')))
  const features: Features = { product: p, core, kind: words.find(word => KINDS.has(word)) ?? '', technical, dimensions: unique(dimensions), unknownUnits,
    shapes, colors, polarity, brands: allBrands, brandConflict: allBrands.length > 1, unit: unit(p.unit), fieldSku, codes, barcodes: barcodes(p), articles: candidates, nameKey: '' }
  features.nameKey = JSON.stringify([core, features.dimensions, technical, shapes, colors, polarity])
  return features
}

type Evidence = Pick<CleanupGroup, 'level' | 'reasons' | 'conflicts'>
function compare(a: Features, b: Features): Evidence | null {
  const sameBarcode = overlap(a.barcodes, b.barcodes), sameCode = overlap(a.codes, b.codes), sameName = a.nameKey === b.nameKey && a.core.length > 0
  const common = a.core.filter(token => b.core.includes(token)).length
  const similarity = common / Math.max(a.core.length, b.core.length, 1)
  const nearName = common > 0 && similarity >= 0.75 && (!a.kind || !b.kind || a.kind === b.kind)
  if (!sameBarcode && !sameCode && !sameName && !nearName) return null
  const reasons: string[] = [], conflicts: string[] = [], uncertainty: string[] = []
  if (sameBarcode) reasons.push('Спільний основний або додатковий штрихкод')
  if (sameCode) reasons.push('Спільний артикул у полі або назві')
  if (sameName) reasons.push('Назва й явні характеристики збігаються після обмеженої нормалізації')
  else if (nearName) reasons.push('Схожі змістові слова назви — потрібна перевірка')
  if (a.brandConflict || b.brandConflict) conflicts.push('Бренд у полі суперечить бренду в назві або вказано кілька брендів')
  if (a.brands.length && b.brands.length && !equal(a.brands, b.brands)) conflicts.push('Різні бренди')
  else if (Boolean(a.brands.length) !== Boolean(b.brands.length)) uncertainty.push('В однієї картки бренд не визначено')
  if (a.unit && b.unit && a.unit !== b.unit) conflicts.push('Різні облікові одиниці товару')
  else if (!a.unit || !b.unit) uncertainty.push('Не визначено облікову одиницю')
  if (a.kind && b.kind && a.kind !== b.kind) conflicts.push('Різний вид товару попри збіг коду')
  for (const [field, label] of [['dimensions', 'розміри, фасування або кількісні характеристики'], ['shapes', 'форма'], ['colors', 'колір або покриття'], ['polarity', 'полярність'], ['technical', 'модель або технічні числа']] as const) {
    if (a[field].length && b[field].length && !equal(a[field], b[field])) conflicts.push('Різні ' + label)
    else if (Boolean(a[field].length) !== Boolean(b[field].length)) uncertainty.push('Не в обох назвах указані: ' + label)
  }
  if (a.fieldSku.length >= 4 && b.fieldSku.length >= 4 && a.fieldSku !== b.fieldSku) uncertainty.push('Різні артикули в полях можуть бути внутрішніми кодами; потрібна перевірка')
  for (const item of [a, b]) if (item.fieldSku && item.articles.some(article => article.explicit && article.key !== item.fieldSku)) conflicts.push('Явний артикул із назви суперечить заповненому полю')
  if (a.unknownUnits.length || b.unknownUnits.length) uncertainty.push('Неоднозначна одиниця в назві: ' + unique([...a.unknownUnits, ...b.unknownUnits]).join(', ') + '; автоматично не виправляється')
  if (a.product.brand_id && b.product.brand_id && a.product.brand_id !== b.product.brand_id && equal(a.brands, b.brands)) uncertainty.push('Однаковий текст бренду прив’язано до різних записів довідника')
  const descriptive = a.core.length >= 2 || Boolean(a.kind && (a.dimensions.length || a.brands.length))
  if (!descriptive && !sameBarcode && !sameCode) uncertainty.push('Назва надто загальна для точного зіставлення')
  if (a.product.purchase_price !== b.product.purchase_price || a.product.retail_price !== b.product.retail_price) reasons.push('Ціни відрізняються: їх не можна обрати або перерахувати автоматично')
  // Distinct sizes/brands/forms are ordinary catalog variants, not thousands of
  // duplicate warnings. Surface contradictions only when an identifier collides.
  if (conflicts.length && !sameBarcode && !sameCode) return null
  const level = conflicts.length ? 'conflict' : sameName && !uncertainty.length ? 'exact' : 'review'
  return { level, reasons: unique([...reasons, ...uncertainty, ...(level === 'exact' ? ['Точний збіг правил, не статистична гарантія тотожності; потрібен перегляд перед злиттям'] : [])]), conflicts: unique(conflicts) }
}
function target(products: Features[]) {
  return [...products].sort((a, b) => {
    const quality = (p: Features) => Number(Boolean(p.fieldSku)) + Number(Boolean(p.product.brand)) + Number(Boolean(p.product.barcode))
    const date = (p: Features) => { const parsed = Date.parse(p.product.created_at ?? ''); return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER }
    return quality(b) - quality(a) || date(a) - date(b) || a.product.id.localeCompare(b.product.id)
  })[0].product.id
}
export function analyzeCatalogCleanup(products: readonly CleanupProduct[]): CatalogCleanupAnalysis {
  if (!Array.isArray(products) || products.length > 100_000) throw Error('Перевірка підтримує до 100000 товарів за один запуск')
  const ids = new Set<string>(), knownBrands = new Map<string, string>(Object.entries(BRAND_ALIASES))
  for (const product of products) {
    if (!product.id || ids.has(product.id)) throw Error('Повторний або порожній ідентифікатор товару')
    if (typeof product.name !== 'string' || product.name.length > 4000) throw Error('Некоректна або надто довга назва товару')
    ids.add(product.id)
    const value = brand(product.brand); if (value) knownBrands.set(code(product.brand).toLowerCase(), value)
  }
  const features = products.map(product => prepare(product, knownBrands)).sort((a, b) => a.product.id.localeCompare(b.product.id))
  const usedSkus = new Set(features.map(item => item.fieldSku).filter(Boolean))
  const sku_suggestions: CleanupSkuSuggestion[] = []
  for (const item of features) for (const article of item.articles) {
    if (article.key === item.fieldSku) continue
    const blocked = item.fieldSku ? 'Поле артикулу вже заповнене; його не можна мовчки замінювати'
      : item.articles.length > 1 ? 'У назві кілька можливих артикулів; оберіть свідомо'
      : usedSkus.has(article.key) ? 'Такий артикул уже належить іншій картці; спочатку перевірте дубль' : undefined
    sku_suggestions.push({ product_id: item.product.id, sku: article.raw, evidence: (article.explicit ? 'Явно позначений артикул у назві: ' : 'Схожий на каталожний номер фрагмент назви: ') + article.raw, ...(blocked ? { blocked } : {}) })
  }
  const frequency = new Map<string, number>()
  for (const item of features) for (const word of item.core) frequency.set(word, (frequency.get(word) ?? 0) + 1)
  const blocks = new Map<string, number[]>()
  const add = (key: string, index: number) => { const rows = blocks.get(key); if (rows) rows.push(index); else blocks.set(key, [index]) }
  features.forEach((item, index) => {
    for (const barcode of item.barcodes) add('b:' + barcode, index)
    for (const article of item.codes) add('s:' + article, index)
    if (item.core.length) add('n:' + item.nameKey, index)
    const words = [...item.core].sort((a, b) => (frequency.get(a)! - frequency.get(b)!) || a.localeCompare(b)).slice(0, 4)
    // Weak text candidates must agree on the available technical signature.
    // Generic words such as "фільтр паливний" alone are not duplicate evidence.
    if (words.length >= 2 && (item.kind || item.brands.length)) {
      const signature = JSON.stringify([item.brands, item.dimensions, item.technical, item.shapes, item.colors, item.polarity])
      for (let i = 0; i < words.length; i++) for (let j = i + 1; j < words.length; j++) add('t:' + signature + ':' + [words[i], words[j]].sort().join('\0'), index)
    }
  })
  const warnings: string[] = [], pairs = new Set<string>(), evidence = new Map<string, Evidence>(), neighbours = new Map<number, Set<number>>()
  let skipped = 0, capped = false
  const keyFor = (a: number, b: number) => a < b ? a + ':' + b : b + ':' + a
  const priority = (key: string) => key.startsWith('b:') ? 0 : key.startsWith('s:') ? 1 : key.startsWith('n:') ? 2 : 3
  scan: for (const [, block] of [...blocks.entries()].sort(([a], [b]) => priority(a) - priority(b) || a.localeCompare(b))) {
    if (block.length > MAX_BLOCK) { skipped++; continue }
    for (let i = 0; i < block.length; i++) for (let j = i + 1; j < block.length; j++) {
      const key = keyFor(block[i], block[j]); if (pairs.has(key)) continue
      if (pairs.size >= MAX_PAIRS) { capped = true; break scan }
      pairs.add(key)
      const result = compare(features[block[i]], features[block[j]])
      if (result) {
        evidence.set(key, result)
        for (const [from, to] of [[block[i], block[j]], [block[j], block[i]]]) { const adjacent = neighbours.get(from) ?? new Set<number>(); adjacent.add(to); neighbours.set(from, adjacent) }
      }
    }
  }
  if (skipped) warnings.push(`Не порівняно ${skipped} надто широких груп (понад ${MAX_BLOCK} карток у кожній). Результат не є повною перевіркою цих груп.`)
  if (capped) warnings.push(`Досягнуто безпечної межі ${MAX_PAIRS} порівнянь. Частина можливих збігів не перевірена.`)
  const groups: CleanupGroup[] = [], covered = new Set<string>()
  for (const level of ['exact', 'review', 'conflict'] as const) for (const [key, first] of evidence) {
    if (first.level !== level || covered.has(key)) continue
    const members = key.split(':').map(Number)
    // Complete-link only: no connected-component/union-find chain may combine conflicting endpoints.
    if (level !== 'conflict') for (const candidate of [...(neighbours.get(members[0]) ?? [])].sort((a, b) => a - b)) {
      if (members.length >= MAX_GROUP) break
      if (members.includes(candidate)) continue
      if (members.every(member => { const edge = evidence.get(keyFor(member, candidate)); return edge && (level === 'exact' ? edge.level === 'exact' : edge.level !== 'conflict') })) members.push(candidate)
    }
    const reasons: string[] = [], conflicts: string[] = []
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
      const edgeKey = keyFor(members[i], members[j]), edge = evidence.get(edgeKey)!
      covered.add(edgeKey); reasons.push(...edge.reasons); conflicts.push(...edge.conflicts)
    }
    const product_ids = members.map(index => features[index].product.id).sort()
    groups.push({ id: stableId([level, product_ids]), level, reasons: unique(reasons), conflicts: unique(conflicts), product_ids, suggested_target_id: target(members.map(index => features[index])) })
  }
  return { groups, sku_suggestions, warnings, stats: { products: products.length, candidate_pairs: pairs.size, skipped_large_blocks: skipped } }
}
