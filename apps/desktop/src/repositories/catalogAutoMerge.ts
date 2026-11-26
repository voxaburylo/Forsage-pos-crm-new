import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import type { LocalProductUpsert } from '../db/localTypes'
import { cleanupCartBlockers } from '../security/catalogCleanupSafety'
import { CatalogCleanupRepository } from './catalogCleanupRepository'
import { LocalCatalogRepository } from './catalogRepository'

/**
 * 26.11.2026, слово власника: «дублі зі стовідсотковою схожістю обʼєднувати автоматично… не треба блоку кнопок, це зайве;
 * просто хай воно працює в автоматі, у фоні. Відлагодь, щоб це чітко працювало».
 *
 * Головний ПК раз на добу сам обʼєднує картки-дублі, що проходять СУВОРЕ правило. Усе інше лишається людині
 * (екран «Очищення номенклатури», нічна перевірка «Кілька карток з однаковою назвою»).
 *
 * Перевірено на копії бази (лише читання): карток з однаковим артикулом чи штрихкодом немає — програма таких не допускає;
 * справжні дублі — однакова назва й різні внутрішні коди (75 назв, 151 картка). «Точні» групи пошуку дублів для автоматики
 * замʼякі: серед них лампа W16W OSRAM і лампа W16W PHILIPS, «Ліхтар BL-511 Police» за 135 грн і «Ліхтарик BL-511» за 290.
 * Правило:
 *  1) назви збігаються БУКВА В БУКВУ (без огляду лише на великі літери й зайві пробіли);
 *  2) та сама одиниця обліку, немає двох різних брендів;
 *  3) немає двох РІЗНИХ заводських штрихкодів (код, що починається з 2, — внутрішній код магазину);
 *  4) ціни карток відрізняються не більш ніж на 30% (більша різниця — ознака іншого фасування чи іншого товару);
 *  5) не більше 4 карток, без відʼємних залишків;
 *  6) після обʼєднання ціна продажу не нижча за закупку.
 * Ціна продажу й закупка — більші з карток (ціни автоматично не знижуються); кількість — сума.
 * Запис — той самий, що й ручне «Залишити цю картку» (CatalogCleanupRepository): воно ще раз перевіряє тотожність,
 * відкриті чеки, накладні, ревізії, замовлення, резерви — і відмовляє, якщо щось заважає. Перед записом — копія бази.
 */
export const AUTO_MERGE_MAX_CARDS = 4
/** Найбільша ціна серед карток — не більш ніж у стільки разів вища за найменшу. */
export const AUTO_MERGE_PRICE_RATIO = 1.3
/** Груп за один прохід: кожна — частки секунди запису в базу; каса при цьому не «підвисає». */
export const AUTO_MERGE_PER_RUN = 12
export const AUTO_MERGE_EVERY_HOURS = 20
export const AUTO_MERGE_KEY = 'catalog-auto-merge:v1'
export const AUTO_MERGE_REASON = 'Автоматичне обʼєднання точних дублів (правило власника 26.11.2026): назва збігається буква в букву, ціни близькі, заводські штрихкоди не суперечать'

export interface AutoMergeCard {
  id: string; name: string; sku: string | null; barcode: string | null; additional_barcodes: string[]
  unit: string | null; brand_id: string | null; qty_on_hand: number; purchase_price: number; retail_price: number; created_at: string | null
}
export type AutoMergeVerdict =
  | { ok: true; target_id: string; source_ids: string[]; retail_price: number; purchase_price: number; raise: boolean; quantity: number }
  | { ok: false; reason: string }

export const literalName = (value: unknown) => String(value ?? '').normalize('NFKC').toLocaleLowerCase('uk').replace(/\s+/g, ' ').trim()
const spread = (values: number[]) => { const known = values.filter(value => value > 0); return known.length < 2 ? 1 : Math.max(...known) / Math.min(...known) }
const realSku = (card: AutoMergeCard) => Boolean(card.sku && !/^(AUTO|AI)-/i.test(card.sku))

/** Заводський штрихкод: 8–14 цифр і не діапазон 20–29, який GS1 лишив магазинам для власних наклейок. */
export function factoryBarcode(value: unknown): boolean {
  const code = String(value ?? '').trim()
  return /^\d{8,14}$/.test(code) && !code.startsWith('2')
}
const hasFactoryBarcode = (card: AutoMergeCard) => [card.barcode, ...card.additional_barcodes].some(factoryBarcode)

/**
 * Головною лишається картка, якою зручніше користуватись: із заводським штрихкодом, зі справжнім артикулом,
 * з більшим залишком, старша. Усі штрихкоди, артикули й назви решти карток переходять до неї (пошук їх знаходить).
 */
export function autoMergeTarget(cards: readonly AutoMergeCard[]): AutoMergeCard {
  const created = (card: AutoMergeCard) => { const at = Date.parse(card.created_at ?? ''); return Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER }
  return [...cards].sort((a, b) => Number(hasFactoryBarcode(b)) - Number(hasFactoryBarcode(a)) || Number(realSku(b)) - Number(realSku(a))
    || (Number(b.qty_on_hand) || 0) - (Number(a.qty_on_hand) || 0) || created(a) - created(b) || a.id.localeCompare(b.id))[0]
}

export function autoMergeVerdict(cards: readonly AutoMergeCard[]): AutoMergeVerdict {
  if (cards.length < 2) return { ok: false, reason: 'Потрібні щонайменше дві картки' }
  if (cards.length > AUTO_MERGE_MAX_CARDS) return { ok: false, reason: `Понад ${AUTO_MERGE_MAX_CARDS} картки з однією назвою` }
  if (!literalName(cards[0].name) || new Set(cards.map(card => literalName(card.name))).size !== 1) return { ok: false, reason: 'Назви не збігаються буква в букву' }
  if (new Set(cards.map(card => literalName(card.unit || 'шт'))).size !== 1) return { ok: false, reason: 'Різні одиниці обліку' }
  if (new Set(cards.map(card => card.brand_id).filter(Boolean)).size > 1) return { ok: false, reason: 'Різні бренди в картках' }
  // Дві РІЗНІ картки зі своїми заводськими кодами без жодного спільного — це, найімовірніше, різні товари (кабель Baseus
  // двох довжин з однаковою назвою). Кілька заводських кодів на ОДНІЙ картці — звичайна річ (виробник змінив код).
  const factory = cards.map(card => [card.barcode, ...card.additional_barcodes].filter(factoryBarcode).map(code => String(code).trim())).filter(codes => codes.length > 0)
  if (factory.some((left, i) => factory.slice(i + 1).some(right => !left.some(code => right.includes(code))))) return { ok: false, reason: 'Різні заводські штрихкоди' }
  if (cards.some(card => Number(card.qty_on_hand) < 0)) return { ok: false, reason: 'Відʼємний залишок' }
  if (spread(cards.map(card => Number(card.retail_price) || 0)) > AUTO_MERGE_PRICE_RATIO || spread(cards.map(card => Number(card.purchase_price) || 0)) > AUTO_MERGE_PRICE_RATIO)
    return { ok: false, reason: 'Ціни карток відрізняються більш ніж на 30%' }
  const retail = Math.max(...cards.map(card => Number(card.retail_price) || 0)), purchase = Math.max(...cards.map(card => Number(card.purchase_price) || 0))
  if (retail > 0 && purchase > retail) return { ok: false, reason: 'Ціна продажу вийшла б нижчою за закупку' }
  const target = autoMergeTarget(cards)
  return {
    ok: true, target_id: target.id, source_ids: cards.filter(card => card.id !== target.id).map(card => card.id).sort(), retail_price: retail, purchase_price: purchase,
    raise: (Number(target.retail_price) || 0) < retail || (Number(target.purchase_price) || 0) < purchase,
    quantity: cards.reduce((sum, card) => sum + (Number(card.qty_on_hand) || 0), 0),
  }
}

export interface AutoMergePlanRow { key: string; name: string; verdict: Extract<AutoMergeVerdict, { ok: true }> }
export interface AutoMergePlan { rows: AutoMergePlanRow[]; skipped: Record<string, number>; same_name_groups: number }

/** Картки з однаковою назвою — прямо з бази, без важкого пошуку схожих (він тут не потрібен: назва збігається повністю). */
export function autoMergePlan(db: Pick<LocalDatabase, 'prepare'>, tenantId: string): AutoMergePlan {
  const cards = db.prepare(`SELECT id,name,sku,barcode,unit,brand_id,qty_on_hand,purchase_price,retail_price,created_at FROM products
    WHERE tenant_id=? AND deleted_at IS NULL AND is_active=1 AND is_service=0 ORDER BY id`).all(tenantId) as Array<Omit<AutoMergeCard, 'additional_barcodes'>>
  const extra = new Map<string, string[]>()
  for (const row of db.prepare('SELECT product_id,barcode FROM product_barcodes WHERE tenant_id=? AND deleted_at IS NULL ORDER BY barcode').all(tenantId) as Array<{ product_id: string; barcode: string }>) {
    const list = extra.get(row.product_id)
    if (list) list.push(row.barcode); else extra.set(row.product_id, [row.barcode])
  }
  const groups = new Map<string, AutoMergeCard[]>()
  for (const card of cards) {
    const key = literalName(card.name)
    if (!key) continue
    const full = { ...card, additional_barcodes: extra.get(card.id) ?? [] }
    const list = groups.get(key)
    if (list) list.push(full); else groups.set(key, [full])
  }
  const plan: AutoMergePlan = { rows: [], skipped: {}, same_name_groups: 0 }
  for (const list of groups.values()) {
    if (list.length < 2) continue
    plan.same_name_groups += 1
    const verdict = autoMergeVerdict(list)
    if (verdict.ok) plan.rows.push({ key: [verdict.target_id, ...verdict.source_ids].sort().join('+'), name: list[0].name, verdict })
    else plan.skipped[verdict.reason] = (plan.skipped[verdict.reason] ?? 0) + 1
  }
  plan.rows.sort((a, b) => b.verdict.quantity - a.verdict.quantity || a.key.localeCompare(b.key))
  return plan
}

export interface AutoMergeState {
  /** Коли всі групи поточного кола переглянуто; наступне коло — через AUTO_MERGE_EVERY_HOURS. */
  finished_at: string | null
  last_run_at: string | null
  /** Групи, які в цьому колі вже пробували (обʼєднано або каса відмовила) — щоб не ходити по тих самих. */
  attempted: string[]
  last: { merged: number; cards: number; refused: Record<string, number>; rule_skipped: Record<string, number>; note: string | null } | null
}
const EMPTY: AutoMergeState = { finished_at: null, last_run_at: null, attempted: [], last: null }

export function readAutoMergeState(db: Pick<LocalDatabase, 'prepare'>): AutoMergeState {
  try {
    const row = db.prepare('SELECT value_json FROM app_meta WHERE key = ?').get(AUTO_MERGE_KEY) as { value_json: string } | undefined
    const saved = row ? JSON.parse(row.value_json) as Partial<AutoMergeState> : null
    if (!saved || typeof saved !== 'object') return { ...EMPTY }
    return {
      finished_at: typeof saved.finished_at === 'string' ? saved.finished_at : null, last_run_at: typeof saved.last_run_at === 'string' ? saved.last_run_at : null,
      attempted: Array.isArray(saved.attempted) ? saved.attempted.filter(item => typeof item === 'string').slice(0, 2000) : [],
      last: saved.last && typeof saved.last === 'object' ? saved.last as AutoMergeState['last'] : null,
    }
  } catch { return { ...EMPTY } }
}
function writeState(db: Pick<LocalDatabase, 'prepare'>, state: AutoMergeState, at: string) {
  db.prepare(`INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(AUTO_MERGE_KEY, JSON.stringify(state), at)
}
export function autoMergeDue(state: AutoMergeState, now: Date): boolean {
  const last = state.finished_at ? Date.parse(state.finished_at) : NaN
  return !Number.isFinite(last) || now.getTime() - last >= AUTO_MERGE_EVERY_HOURS * 3_600_000
}

export interface AutoMergeHost {
  db: LocalDatabase
  tenantId: string
  /**
   * Збережені відкриті чеки з вікна програми (ті самі записи, що читає ручне обʼєднання). null — вікна зараз немає:
   * перевірити чеки нічим, тому цього разу нічого не обʼєднуємо.
   */
  readOpenReceipts: () => Promise<unknown | null>
  backup: () => Promise<unknown>
  /** Обслуговування бази або ручне обʼєднання — не заважаємо. */
  busy: () => boolean
  /** Позначка «йде запис обʼєднання» — та сама, що блокує друге ручне обʼєднання. */
  lock: (on: boolean) => void
  now?: () => Date
  /** Перепочинок між групами, щоб каса відповідала касиру. */
  pause?: () => Promise<void>
}
export type AutoMergeOutcome =
  | { status: 'not-due' | 'busy' | 'no-window' | 'no-owner' | 'server-unproven' }
  | { status: 'ran'; merged: number; cards: number; refused: Record<string, number>; left: number; finished: boolean }

const harmless = (warning: string) => ['Ціни відрізняються', 'Фактичну наявність не перевірено', 'Потрібне підтвердження тотожності'].some(start => warning.startsWith(start))
const short = (text: string) => text.replace(/:.*$/s, '').slice(0, 120)

/**
 * Один прохід. Нічого не кидає назовні через окрему групу: група, якій каса відмовила, рахується у «refused».
 * Умови запуску: настав час; не йде обслуговування; сервер уже приймав таке обʼєднання (у черзі є передане
 * «product.catalog_cleanup»); є власник, від імені якого записується журнал; відкрите вікно (щоб звірити відкриті чеки).
 */
export async function catalogAutoMergeTick(host: AutoMergeHost): Promise<AutoMergeOutcome> {
  const { db, tenantId } = host
  const now = () => host.now?.() ?? new Date()
  let state = readAutoMergeState(db)
  if (!autoMergeDue(state, now())) return { status: 'not-due' }
  if (host.busy()) return { status: 'busy' }
  const note = (text: string, status: 'no-owner' | 'server-unproven'): AutoMergeOutcome => {
    const at = now().toISOString()
    writeState(db, { ...state, finished_at: at, last_run_at: at, attempted: [], last: { merged: 0, cards: 0, refused: {}, rule_skipped: {}, note: text } }, at)
    return { status }
  }
  // Сервер має вміти прийняти обʼєднання: доказ — уже передане ручне обʼєднання з цієї каси.
  if (!db.prepare("SELECT 1 FROM sync_outbox WHERE tenant_id=? AND operation_type='product.catalog_cleanup' AND status='synced' LIMIT 1").get(tenantId))
    return note('Сервер ще не приймав обʼєднання з цієї каси — спершу обʼєднайте одну пару вручну', 'server-unproven')
  const owner = db.prepare("SELECT id FROM staff_users WHERE tenant_id=? AND role='owner' AND is_active=1 AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1").get(tenantId) as { id: string } | undefined
  if (!owner) return note('Немає діючого власника в довіднику працівників', 'no-owner')

  const plan = autoMergePlan(db, tenantId)
  const attempted = new Set(state.attempted)
  const todo = plan.rows.filter(row => !attempted.has(row.key))
  const finish = (merged: number, cards: number, refused: Record<string, number>, left: number): AutoMergeOutcome => {
    const at = now().toISOString(), finished = left === 0
    state = { finished_at: finished ? at : state.finished_at, last_run_at: at, attempted: finished ? [] : [...attempted],
      last: { merged, cards, refused, rule_skipped: plan.skipped, note: null } }
    writeState(db, state, at)
    return { status: 'ran', merged, cards, refused, left, finished }
  }
  if (!todo.length) return finish(0, 0, {}, 0)
  if ((await host.readOpenReceipts()) === null) return { status: 'no-window' }
  await host.backup()

  const catalog = new LocalCatalogRepository(db)
  const refused: Record<string, number> = {}
  let merged = 0, cards = 0, done = 0
  for (const row of todo.slice(0, AUTO_MERGE_PER_RUN)) {
    if (host.busy()) break
    // Чеки читаємо перед кожною групою; далі до кінця запису — жодного очікування (синхронна транзакція бази).
    const receipts = await host.readOpenReceipts()
    if (receipts === null || host.busy()) break
    const { verdict } = row
    host.lock(true)
    try {
      const repository = new CatalogCleanupRepository(db, { canMirrorMerge: () => true, externalBlockers: ids => cleanupCartBlockers(receipts, ids) })
      const ask = () => repository.preview({ tenant_id: tenantId, target_id: verdict.target_id, source_ids: verdict.source_ids, stock_review: 'pending' })
      let preview = ask()
      const doubts = () => [...preview.blockers, ...preview.warnings.filter(warning => !harmless(warning))]
      if (!doubts().length && preview.can_apply && verdict.raise) {
        // Ціну піднімаємо лише тоді, коли каса вже погодилась обʼєднати: відмовила — картка лишається як була.
        catalog.saveProduct({ id: verdict.target_id, tenant_id: tenantId, retail_price: verdict.retail_price, purchase_price: verdict.purchase_price } as LocalProductUpsert)
        preview = ask()
      }
      if (doubts().length || !preview.can_apply) { for (const text of doubts().length ? doubts() : ['Каса не дозволила обʼєднання']) refused[short(text)] = (refused[short(text)] ?? 0) + 1 }
      else {
        repository.apply({ tenant_id: tenantId, target_id: verdict.target_id, source_ids: verdict.source_ids, stock_review: 'pending',
          operation_id: randomUUID(), preview_fingerprint: preview.fingerprint, reason: AUTO_MERGE_REASON }, owner.id)
        merged += 1; cards += verdict.source_ids.length
      }
    } catch (error) {
      const text = short(error instanceof Error ? error.message : 'Не вдалося обʼєднати')
      refused[text] = (refused[text] ?? 0) + 1
    } finally { host.lock(false) }
    attempted.add(row.key); done += 1
    await (host.pause?.() ?? new Promise<void>(resolve => setImmediate(resolve)))
  }
  return finish(merged, cards, refused, todo.length - done)
}
