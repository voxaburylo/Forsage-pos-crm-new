import type { CleanupMergeInput, CleanupPreview, CleanupProduct, CleanupScan } from './catalogCleanupModel'

/**
 * 26.11.2026, слово власника: «дублі зараз обʼєднуємо лише через ШІ; може, додати правило в самій програмі — дублі зі
 * стовідсотковою схожістю обʼєднувати автоматично, наприклад коли артикул і штрихкод сходяться».
 *
 * Перевірено на копії бази (лише читання):
 *  — карток з однаковим артикулом чи штрихкодом немає взагалі: програма таких не допускає;
 *  — справжні дублі — картки з ОДНАКОВОЮ НАЗВОЮ і різними внутрішніми кодами (75 назв, 151 картка);
 *  — «точні» групи пошуку дублів каси для автоматики замʼякі: серед них лампа W16W OSRAM і лампа W16W PHILIPS,
 *    «Ліхтар BL-511 Police» за 135 грн і «Ліхтарик BL-511» за 290 грн, «Клеми акумулятора» за 65 і «Клеми АКБ» за 130.
 * Тому «без перегляду кожної пари» обʼєднується лише те, що проходить суворе правило:
 *  1) назви збігаються БУКВА В БУКВУ (без огляду лише на великі літери й зайві пробіли);
 *  2) пошук дублів каси не бачить між цими картками суперечності (бренд, розмір, сторона, одиниця);
 *  3) у карток немає двох РІЗНИХ заводських штрихкодів (код, що починається з 2, — внутрішній код магазину);
 *  4) ціни карток відрізняються не більш ніж на 30% (більша різниця — ознака іншого фасування чи іншого товару);
 *  5) карток у групі небагато, відʼємних залишків немає;
 *  6) після обʼєднання ціна продажу не нижча за закупку.
 * Ціна продажу й закупка — більші з карток (ціни автоматично не знижуються); кількість — сума.
 * Запис іде тим самим шляхом, що й «Залишити цю картку»: каса ще раз перевіряє кошики, відкриті накладні, ревізії,
 * замовлення — і відмовляє, якщо щось заважає.
 */
export const AUTO_MERGE_MAX_CARDS = 4
/** Найбільша ціна серед карток — не більш ніж у стільки разів вища за найменшу. */
export const AUTO_MERGE_PRICE_RATIO = 1.3
export const AUTO_MERGE_REASON = 'Точний дубль за суворим правилом програми (назва збігається буква в букву, ціни близькі); обʼєднано однією кнопкою власника'
export const literalName = (value: unknown) => String(value ?? '').normalize('NFKC').toLocaleLowerCase('uk').replace(/\s+/g, ' ').trim()
const spread = (values: number[]) => { const known = values.filter(value => value > 0); return known.length < 2 ? 1 : Math.max(...known) / Math.min(...known) }
const realSku = (card: CleanupProduct) => Boolean(card.sku && !/^(AUTO|AI)-/i.test(card.sku))

/** Заводський штрихкод: 8–14 цифр і не діапазон 20–29, який GS1 лишив магазинам для власних наклейок. */
export function factoryBarcode(value: unknown): boolean {
  const code = String(value ?? '').trim()
  return /^\d{8,14}$/.test(code) && !code.startsWith('2')
}
const hasFactoryBarcode = (card: CleanupProduct) => [card.barcode, ...(card.additional_barcodes ?? [])].some(factoryBarcode)

export type AutoMergeVerdict =
  | { ok: true; target_id: string; source_ids: string[]; retail_price: number; purchase_price: number; raise: boolean; quantity: number }
  | { ok: false; reason: string }

/**
 * Головною лишається картка, якою зручніше користуватись: із заводським штрихкодом, зі справжнім артикулом,
 * з більшим залишком, старша. Усі штрихкоди, артикули й назви решти карток переходять до неї (пошук їх знаходить).
 */
export function autoMergeTarget(cards: readonly CleanupProduct[]): CleanupProduct {
  const created = (card: CleanupProduct) => { const at = Date.parse(card.created_at ?? ''); return Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER }
  return [...cards].sort((a, b) => Number(hasFactoryBarcode(b)) - Number(hasFactoryBarcode(a)) || Number(realSku(b)) - Number(realSku(a))
    || (Number(b.qty_on_hand) || 0) - (Number(a.qty_on_hand) || 0) || created(a) - created(b) || a.id.localeCompare(b.id))[0]
}

export function autoMergeVerdict(cards: readonly CleanupProduct[]): AutoMergeVerdict {
  if (cards.length < 2) return { ok: false, reason: 'Потрібні щонайменше дві картки' }
  if (cards.length > AUTO_MERGE_MAX_CARDS) return { ok: false, reason: `Понад ${AUTO_MERGE_MAX_CARDS} картки з однією назвою — перегляньте вручну` }
  if (!literalName(cards[0].name) || new Set(cards.map(card => literalName(card.name))).size !== 1) return { ok: false, reason: 'Назви не збігаються буква в букву' }
  if (new Set(cards.map(card => literalName(card.unit))).size !== 1) return { ok: false, reason: 'Різні одиниці обліку' }
  if (new Set(cards.map(card => card.brand_id).filter(Boolean)).size > 1) return { ok: false, reason: 'Різні бренди в картках' }
  const factory = new Set(cards.flatMap(card => [card.barcode, ...(card.additional_barcodes ?? [])]).filter(factoryBarcode).map(code => String(code).trim()))
  if (factory.size > 1) return { ok: false, reason: 'Різні заводські штрихкоди — це можуть бути різні товари' }
  if (cards.some(card => Number(card.qty_on_hand) < 0)) return { ok: false, reason: 'Відʼємний залишок — спершу звірте його' }
  if (spread(cards.map(card => Number(card.retail_price) || 0)) > AUTO_MERGE_PRICE_RATIO || spread(cards.map(card => Number(card.purchase_price) || 0)) > AUTO_MERGE_PRICE_RATIO)
    return { ok: false, reason: 'Ціни карток відрізняються більш ніж на 30% — можливо, це різне фасування чи різні товари' }
  const retail = Math.max(...cards.map(card => Number(card.retail_price) || 0)), purchase = Math.max(...cards.map(card => Number(card.purchase_price) || 0))
  if (retail > 0 && purchase > retail) return { ok: false, reason: 'Ціна продажу вийшла б нижчою за закупку — спершу виправте ціни' }
  const target = autoMergeTarget(cards)
  return {
    ok: true, target_id: target.id, source_ids: cards.filter(card => card.id !== target.id).map(card => card.id), retail_price: retail, purchase_price: purchase,
    raise: (Number(target.retail_price) || 0) < retail || (Number(target.purchase_price) || 0) < purchase,
    quantity: cards.reduce((sum, card) => sum + (Number(card.qty_on_hand) || 0), 0),
  }
}

export interface AutoMergePlanRow { name: string; cards: CleanupProduct[]; verdict: Extract<AutoMergeVerdict, { ok: true }> }
export interface AutoMergePlan { rows: AutoMergePlanRow[]; skipped: Array<{ name: string; reason: string }>; same_name_groups: number }

/** Що програма готова обʼєднати сама, і чому решту карток з однаковою назвою лишає людині. */
export function autoMergePlan(scan: CleanupScan): AutoMergePlan {
  const groups = new Map<string, CleanupProduct[]>()
  for (const product of scan.products) {
    const key = literalName(product.name)
    if (!key) continue
    const list = groups.get(key)
    if (list) list.push(product); else groups.set(key, [product])
  }
  // Пари, між якими пошук дублів каси знайшов суперечність, — не дублі, хоч би якою була назва.
  const conflicts = new Set<string>()
  for (const group of scan.groups) if (group.level === 'conflict') {
    for (const a of group.product_ids) for (const b of group.product_ids) if (a < b) conflicts.add(a + '|' + b)
  }
  const plan: AutoMergePlan = { rows: [], skipped: [], same_name_groups: 0 }
  for (const cards of groups.values()) {
    if (cards.length < 2) continue
    plan.same_name_groups += 1
    const name = cards[0].name
    const ids = cards.map(card => card.id).sort()
    if (ids.some((a, i) => ids.slice(i + 1).some(b => conflicts.has(a + '|' + b)))) { plan.skipped.push({ name, reason: 'Пошук дублів бачить між картками суперечність — перегляньте вручну' }); continue }
    const verdict = autoMergeVerdict(cards)
    if (verdict.ok) plan.rows.push({ name, cards, verdict }); else plan.skipped.push({ name, reason: verdict.reason })
  }
  plan.rows.sort((a, b) => b.verdict.quantity - a.verdict.quantity || a.name.localeCompare(b.name, 'uk'))
  return plan
}

export interface AutoMergeBridge {
  cleanupPreview: (input: { target_id: string; source_ids: string[]; stock_review: 'pending' | 'checked' }) => Promise<CleanupPreview>
  cleanupApply: (input: CleanupMergeInput & { operation_id: string }) => Promise<{ quantity_after: number; backupPath?: string }>
}
export interface AutoMergeDeps {
  bridge: AutoMergeBridge
  /** Підняти ціни головної картки звичайним шляхом програми (картка товару). */
  raisePrices: (productId: string, prices: { retail_price: number; purchase_price: number }) => Promise<unknown>
  operationId: () => string
  onProgress?: (done: number, total: number) => void
  shouldStop?: () => boolean
}
export interface AutoMergeResult { merged: number; cards: number; skipped: Array<{ name: string; reason: string }>; backupPath: string; stopped: boolean }

/**
 * Обʼєднати план по одній групі. Кожна група: (ціни головної картки — до більших) → свіжа перевірка каси → запис.
 * Група, якій каса відмовила, пропускається з причиною; решта записуються. Три попередження каси групу не зупиняють:
 * різниця цін (щойно розвʼязана на користь більшої), «залишок не перераховано» і «потрібне підтвердження тотожності»
 * (каса просить його через різні внутрішні артикули, а тотожність тут доведена суворішим правилом — назва буква в букву).
 * Будь-яке інше попередження зупиняє групу: її дивиться людина.
 */
export async function applyAutoMerges(rows: readonly AutoMergePlanRow[], deps: AutoMergeDeps): Promise<AutoMergeResult> {
  const result: AutoMergeResult = { merged: 0, cards: 0, skipped: [], backupPath: '', stopped: false }
  const harmless = (warning: string) => ['Ціни відрізняються', 'Фактичну наявність не перевірено', 'Потрібне підтвердження тотожності'].some(start => warning.startsWith(start))
  for (const [index, row] of rows.entries()) {
    if (deps.shouldStop?.()) { result.stopped = true; break }
    const { verdict } = row
    try {
      const ask = () => deps.bridge.cleanupPreview({ target_id: verdict.target_id, source_ids: verdict.source_ids, stock_review: 'pending' })
      let preview = await ask()
      const refused = () => !preview.can_apply || preview.blockers.length > 0 || !preview.fingerprint
      const doubts = () => preview.warnings.filter(warning => !harmless(warning))
      // Ціну піднімаємо лише тоді, коли каса вже погодилась обʼєднати: відмовила — картка лишається як була.
      if (!refused() && !doubts().length && verdict.raise) {
        await deps.raisePrices(verdict.target_id, { retail_price: verdict.retail_price, purchase_price: verdict.purchase_price })
        preview = await ask()
      }
      if (refused()) result.skipped.push({ name: row.name, reason: preview.blockers.join(' · ') || 'Каса не дозволила обʼєднання' })
      else if (doubts().length) result.skipped.push({ name: row.name, reason: doubts().join(' · ') })
      else {
        const saved = await deps.bridge.cleanupApply({ target_id: verdict.target_id, source_ids: verdict.source_ids, stock_review: preview.stock_review,
          preview_fingerprint: preview.fingerprint, reason: AUTO_MERGE_REASON, operation_id: deps.operationId() })
        result.merged += 1; result.cards += verdict.source_ids.length
        result.backupPath = saved?.backupPath ?? result.backupPath
      }
    } catch (error) {
      result.skipped.push({ name: row.name, reason: error instanceof Error ? error.message : 'Не вдалося обʼєднати' })
    }
    deps.onProgress?.(index + 1, rows.length)
  }
  return result
}
