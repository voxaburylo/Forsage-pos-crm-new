import { normalizeArticle } from '../validators/productValidator.js'

/**
 * Швидкий шлях для «знайди дублі» (26.11.2026, слово власника: «щоб свої задачі виконував якісно й швидко»).
 * Раніше модель сама читала групи й друкувала кожну пару з причиною — до двох хвилин і ~8 тис. токенів відповіді на запит
 * (за 26.11: 186 тис. токенів відповіді на 24 запити). Пари з однаковою назвою сервер збирає сам, за секунди; модель лише
 * викликає інструмент і пише одне-два речення.
 *
 * Правила — ті самі, що у фонового обʼєднання каси: головна картка — з більшим залишком, далі зі справжнім артикулом;
 * «точно» лише коли назви збігаються буква в букву й немає ознак різних виробників (різні заводські штрихкоди, різні
 * буквені артикули) — такі пари йдуть у таблицю сумнівних, і власник вирішує сам.
 */
export interface DuplicateCard { product_id: string; sku?: string | null; name?: string | null; qty?: number | string | null; barcode?: string | null }
export interface SameNameMerge { primary_product_id: string; duplicate_product_id: string; reason: string; sure: boolean }

const realSku = (card: DuplicateCard) => { const sku = String(card.sku ?? '').trim(); return sku && !/^AUTO-/i.test(sku) ? sku : '' }
/** Номер виробника — з літерами й цифрами (WA6684), а не внутрішній числовий код (82305). */
const makerSku = (card: DuplicateCard) => { const sku = normalizeArticle(realSku(card)); return /\p{L}/u.test(sku) && /\d/.test(sku) && sku.length >= 4 ? sku : '' }
const factoryBarcode = (card: DuplicateCard) => { const code = String(card.barcode ?? '').trim(); return /^\d{8,14}$/.test(code) && !code.startsWith('2') ? code : '' }
const qty = (card: DuplicateCard) => Number(card.qty) || 0

export function pickPrimary(cards: readonly DuplicateCard[]): DuplicateCard {
  return [...cards].sort((a, b) => qty(b) - qty(a)
    || Number(Boolean(factoryBarcode(b))) - Number(Boolean(factoryBarcode(a)))
    || Number(Boolean(realSku(b))) - Number(Boolean(realSku(a)))
    || a.product_id.localeCompare(b.product_id))[0]
}

export function sameNameMergePairs(groups: ReadonlyArray<{ products: readonly DuplicateCard[] }>, maxPairs = 200): SameNameMerge[] {
  const pairs: SameNameMerge[] = []
  for (const group of groups) {
    const cards = group.products.filter(card => card.product_id)
    if (cards.length < 2) continue
    const primary = pickPrimary(cards)
    for (const card of cards) {
      if (card.product_id === primary.product_id) continue
      if (pairs.length >= maxPairs) return pairs
      const makers = [makerSku(primary), makerSku(card)], codes = [factoryBarcode(primary), factoryBarcode(card)]
      const doubt = makers[0] && makers[1] && makers[0] !== makers[1] ? `різні артикули виробника: ${realSku(primary)} і ${realSku(card)}`
        : codes[0] && codes[1] && codes[0] !== codes[1] ? 'різні заводські штрихкоди — можливо, різні виробники'
        : qty(card) < 0 || qty(primary) < 0 ? 'відʼємний залишок — спершу ревізія' : ''
      pairs.push({ primary_product_id: primary.product_id, duplicate_product_id: card.product_id, sure: !doubt, reason: doubt || 'назва збігається буква в букву' })
    }
  }
  return pairs
}
