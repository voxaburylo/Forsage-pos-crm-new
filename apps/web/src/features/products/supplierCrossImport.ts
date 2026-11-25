import { desktopBridge, isDesktopRuntime } from '@/lib/desktopBridge'

/**
 * 25.11.2026 (власник: «кроси мають працювати скрізь — і в пошуку по нашій базі, щоб підтягувати інші фільтри,
 * які є в нас в аналогах»). Головний ПК раз на годину забирає з сервера кроси й OE-номери Омеги для НАШИХ карток
 * і записує їх у крос-номери карток звичайним шляхом програми (джерело «Омега»). Далі вони працюють скрізь:
 * пошук у «Товарах», каса, замовлення, «Аналоги» — і без інтернету. Нічого не затирається: наявні номери лишаються,
 * повтори пропускаються. Позначка «з якого часу» посувається лише до останньої картки без збою.
 */
export const SUPPLIER_CROSS_SINCE_KEY = 'forsage:supplier-crosses:since'
export const SUPPLIER_CROSS_SOURCE = 'Омега (кроси постачальника)'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface CardCrosses { program_product_id: string; numbers: Array<{ number: string; brand: string | null }>; found_at: string }
export interface CrossImportResult { received: number; cards: number; skippedNoCard: number; failed: number; since: string | null }

/** Лише записи правильної форми: код картки, номери до 120 знаків (бренд до 100), дата. */
export function cleanCardCrosses(raw: unknown): CardCrosses[] {
  if (!Array.isArray(raw)) return []
  const out: CardCrosses[] = []
  for (const item of raw) {
    const row = (item ?? {}) as Partial<CardCrosses>
    if (typeof row.program_product_id !== 'string' || !UUID.test(row.program_product_id)) continue
    if (typeof row.found_at !== 'string' || Number.isNaN(Date.parse(row.found_at))) continue
    const numbers = (Array.isArray(row.numbers) ? row.numbers : []).flatMap(entry => {
      const number = typeof entry?.number === 'string' ? entry.number.trim() : ''
      if (!number || number.length > 120 || !/[\p{L}\p{N}]/u.test(number)) return []
      const brand = typeof entry?.brand === 'string' && entry.brand.trim() ? entry.brand.trim().slice(0, 100) : null
      return [{ number, brand }]
    }).slice(0, 150)
    out.push({ program_product_id: row.program_product_id, numbers, found_at: row.found_at })
  }
  return out.sort((a, b) => Date.parse(a.found_at) - Date.parse(b.found_at))
}

export interface CrossImportDeps {
  list: (since: string | null) => Promise<unknown>
  hasCard: (id: string) => Promise<boolean>
  addCrosses: (id: string, numbers: Array<{ number: string; brand: string | null }>) => Promise<unknown>
  readSince: () => string | null
  writeSince: (value: string) => void
}

export async function importSupplierCrosses(deps: CrossImportDeps): Promise<CrossImportResult> {
  const since = deps.readSince()
  const cards = cleanCardCrosses(await deps.list(since))
  const result: CrossImportResult = { received: cards.length, cards: 0, skippedNoCard: 0, failed: 0, since }
  let safeSince: string | null = null, broken = false
  for (const card of cards) {
    try {
      if (!await deps.hasCard(card.program_product_id)) result.skippedNoCard += 1
      else if (card.numbers.length) { await deps.addCrosses(card.program_product_id, card.numbers); result.cards += 1 }
      if (!broken) safeSince = card.found_at
    } catch { result.failed += 1; broken = true }
  }
  if (safeSince && safeSince !== since) { deps.writeSince(safeSince); result.since = safeSince }
  return result
}

/** Лише головний ПК зі своїм ключем звʼязку. */
export function canImportSupplierCrosses(): boolean {
  const bridge = desktopBridge()
  return isDesktopRuntime() && Boolean(bridge?.link?.assistant && bridge.catalog?.findById && bridge.catalog?.changeCrossNumbers)
}

/** Один прохід справжніми засобами програми; кілька порцій за раз, поки сервер віддає повні сторінки. */
export async function runSupplierCrossImport(maxPages = 5): Promise<CrossImportResult | null> {
  const bridge = desktopBridge()
  const send = bridge?.link?.assistant, catalog = bridge?.catalog
  if (!canImportSupplierCrosses() || !send || !catalog?.findById) return null
  const { productApi } = await import('./productApi')
  let last: CrossImportResult | null = null
  for (let page = 0; page < maxPages; page += 1) {
    last = await importSupplierCrosses({
      list: async since => {
        const answer = await send({ method: 'GET', path: '/supplier-crosses' + (since ? '?since=' + encodeURIComponent(since) : '') })
        if (!answer) throw new Error('Звʼязок головного ПК не налаштовано')
        const parsed = JSON.parse(answer.text) as { data?: unknown; error?: { message?: string } }
        if (answer.status !== 200) throw new Error(parsed?.error?.message || 'Сервер не віддав кроси (код ' + answer.status + ')')
        return parsed.data
      },
      hasCard: async id => Boolean(await catalog.findById!(id)),
      addCrosses: (id, numbers) => productApi.addCrossNumbers(id, numbers, SUPPLIER_CROSS_SOURCE),
      readSince: () => { try { return localStorage.getItem(SUPPLIER_CROSS_SINCE_KEY) } catch { return null } },
      writeSince: value => { try { localStorage.setItem(SUPPLIER_CROSS_SINCE_KEY, value) } catch { /* наступний прохід повторить; повтори пропускаються */ } },
    })
    if (last.received < 100 || last.failed) break
  }
  return last
}
