const BLOCKED_SOURCE_DOMAINS = [
  'google.', 'bing.com', 'yahoo.', 'yandex.', 'duckduckgo.',
  'facebook.com', 'instagram.com', 'tiktok.com', 'youtube.com',
  'amazon.', 'ebay.', 'aliexpress.', 'prom.ua', 'rozetka.',
]

export function normalizeAiCatalogCode(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-ZА-ЯІЇЄҐ0-9]/g, '')
}

export function isPlaceholderSku(value: string | null | undefined): boolean {
  return /^AUTO-/i.test(String(value ?? '').trim())
}

export function safeCatalogNumber(value: string | null | undefined): string | null {
  const normalized = normalizeAiCatalogCode(value)
  if (normalized.length < 4 || normalized.length > 40 || !/\d/.test(normalized)) return null
  if (/^(AUTO|POS)/.test(normalized)) return null
  if (/^\d{8}$|^\d{12,14}$/.test(normalized)) return null
  if (/^\d{1,2}W\d{1,2}$/.test(normalized)) return null
  if (/^\d+(?:ML|L|KG|G|MM|CM|M|V|W|A|AH|C)$/.test(normalized)) return null
  return normalized
}

export function evidenceDomain(value: string | null | undefined): string | null {
  try {
    const url = new URL(String(value ?? ''))
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    if (!host || BLOCKED_SOURCE_DOMAINS.some((blocked) => host === blocked || host.includes(blocked))) return null
    return host
  } catch {
    return null
  }
}

export function groundedSourceLabel(
  title: string | null | undefined,
  uri: string | null | undefined,
): string | null {
  const directDomain = evidenceDomain(uri)
  if (directDomain) return directDomain

  try {
    const host = new URL(String(uri ?? '')).hostname.toLowerCase()
    if (host !== 'vertexaisearch.cloud.google.com') return null
  } catch {
    return null
  }

  const cleanTitle = String(title ?? '').replace(/\s+/g, ' ').trim()
  const normalizedTitle = cleanTitle.toLowerCase()
  if (!cleanTitle || BLOCKED_SOURCE_DOMAINS.some((blocked) => normalizedTitle.includes(blocked))) return null
  return cleanTitle.slice(0, 120)
}
export function normalizedNameContains(name: string, catalogNumber: string): boolean {
  return normalizeAiCatalogCode(name).includes(catalogNumber)
}

/** Пропозиція крос-номерів: лише справжні каталожні номери з нормальним джерелом (не пошуковик/маркетплейс). */
/** 23.11.2026: лише за оригіналом буває до 20 номерів (Hyundai, Kia, Mitsubishi…), плюс аналоги — 50 стало замало. */
export const CROSS_NUMBERS_PER_PRODUCT = 120
/** Скільки товарів за один пошук: менше товарів — глибший пошук по кожному. */
export const CROSS_RESEARCH_PRODUCTS = 3
/** Скільки пошуків в інтернеті на один виклик: кілька на кожен товар (OE по марках авто окремо від аналогів). */
export function crossResearchSearches(products: number): number {
  return Math.min(3 + 4 * Math.max(1, products), 15)
}

const brandKey = (brand: string) => brand.toLocaleLowerCase('uk-UA').replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * 23.11.2026, слово власника: не «номер (Blue Print), номер (Blue Print)», а як у постачальників —
 * «Hyundai: a, b, c; Kia: d, e; MANN: f» — бренд один раз, його номери через кому.
 * Порядок брендів — як їх уперше назвав помічник (спершу оригінал, далі аналоги); «BLUE PRINT» і «Blue Print» — один бренд.
 */
export function groupCrossNumbersByBrand(numbers: ReadonlyArray<{ number: string; brand?: string | null }>): string {
  const groups = new Map<string, { title: string; numbers: string[] }>()
  for (const entry of numbers) {
    const brand = typeof entry.brand === 'string' ? entry.brand.trim() : ''
    const key = brand ? brandKey(brand) : ''
    const group = groups.get(key) ?? { title: brand, numbers: [] }
    if (!group.numbers.includes(entry.number)) group.numbers.push(entry.number)
    groups.set(key, group)
  }
  const named = [...groups.entries()].filter(([key]) => key).map(([, group]) => group.title + ': ' + group.numbers.join(', '))
  const unnamed = groups.get('')
  return [...named, ...(unnamed ? [(named.length ? 'Інші: ' : '') + unnamed.numbers.join(', ')] : [])].join('; ')
}

export function cleanCrossProposal(raw: unknown): Array<{ product_id: string; numbers: Array<{ number: string; brand: string | null; source: string }> }> {
  const result: Array<{ product_id: string; numbers: Array<{ number: string; brand: string | null; source: string }> }> = []
  for (const item of Array.isArray(raw) ? raw.slice(0, 200) : []) {
    const productId = typeof item?.product_id === 'string' ? item.product_id : ''
    if (!productId) continue
    const seen = new Set<string>()
    const numbers: Array<{ number: string; brand: string | null; source: string }> = []
    for (const entry of Array.isArray(item?.numbers) ? item.numbers.slice(0, CROSS_NUMBERS_PER_PRODUCT) : []) {
      const number = typeof entry?.number === 'string' ? entry.number.trim().slice(0, 100) : ''
      const key = safeCatalogNumber(number)
      const source = evidenceDomain(entry?.source_url)
      if (!key || !source || seen.has(key)) continue
      seen.add(key)
      numbers.push({ number, brand: typeof entry?.brand === 'string' && entry.brand.trim() ? entry.brand.trim().slice(0, 100) : null, source })
    }
    if (numbers.length) result.push({ product_id: productId, numbers })
  }
  return result
}
