/**
 * Запис пачки «Змінити товари» (update_products_bulk) з чату помічника в локальну базу каси.
 * Каталог належить касі, тому зміни йдуть тим самим захищеним шляхом, що й «Помічник каталогу»:
 * відбиток картки (не змінена після пропозиції), лише назва й категорія, без зміни цифр і бренду,
 * резервна копія перед записом. Картки, які змінити не можна, пропускаються з причиною.
 */
export interface ChatCatalogUpdate { product_id: string; new_name?: string; category_name?: string }
export interface ChatCatalogSkip { item: string; error: string }
type Fingerprint = { product_id: string; fingerprint: string | null; name?: string; category_id?: string | null }
type AgentItem = { product_id: string; fingerprint: string; changes: { name?: string; category_id?: string } }

export interface ChatCatalogBridge {
  agentFingerprints: (ids: string[]) => Promise<Fingerprint[]>
  agentApply: (input: { operation_id: string; items: AgentItem[]; skip_invalid: true }) => Promise<{ updated: number; skipped?: Array<{ product_id: string; name: string; error: string }>; backupPath?: string }>
}

const normalize = (value: string) => value.trim().toLocaleLowerCase('uk').replace(/\s+/g, ' ')

export function planChatCatalogUpdates(
  updates: readonly ChatCatalogUpdate[],
  fingerprints: readonly Fingerprint[],
  categories: ReadonlyArray<{ id: string; name: string }>,
): { items: AgentItem[]; skipped: ChatCatalogSkip[]; unchanged: number } {
  const byId = new Map(fingerprints.map(row => [row.product_id, row]))
  const categoryIds = new Map(categories.map(category => [normalize(category.name), category.id]))
  const items: AgentItem[] = []
  const skipped: ChatCatalogSkip[] = []
  const seen = new Set<string>()
  let unchanged = 0
  for (const update of updates) {
    const id = String(update?.product_id ?? '')
    const current = byId.get(id)
    const label = String(update?.new_name ?? current?.name ?? id)
    if (!id || seen.has(id)) { skipped.push({ item: label, error: 'Повторний товар у пропозиції' }); continue }
    seen.add(id)
    if (!current?.fingerprint) { skipped.push({ item: label, error: 'Товар не знайдено в базі каси' }); continue }
    const changes: AgentItem['changes'] = {}
    const name = typeof update.new_name === 'string' ? update.new_name.trim().replace(/\s+/g, ' ') : ''
    if (name && name !== current.name) changes.name = name
    if (typeof update.category_name === 'string' && update.category_name.trim()) {
      const categoryId = categoryIds.get(normalize(update.category_name))
      if (!categoryId) {
        skipped.push({ item: current.name ?? label, error: `Категорію «${update.category_name.trim()}» не знайдено. Створіть її в «Категоріях» і повторіть.` })
        continue
      }
      if (categoryId !== current.category_id) changes.category_id = categoryId
    }
    if (!Object.keys(changes).length) { unchanged += 1; continue }
    items.push({ product_id: id, fingerprint: current.fingerprint, changes })
  }
  return { items, skipped, unchanged }
}

type Category = { id: string; name: string }

/** Категорії з пропозиції, яких ще немає: створюються один раз перед записом товарів. */
export async function ensureChatCategories(
  names: readonly unknown[],
  categories: readonly Category[],
  createCategory: (name: string) => Promise<Category>,
): Promise<{ categories: Category[]; created: string[]; failed: ChatCatalogSkip[] }> {
  const all = [...categories]
  const known = new Set(all.map(category => normalize(category.name)))
  const created: string[] = []
  const failed: ChatCatalogSkip[] = []
  for (const raw of names) {
    if (typeof raw !== 'string') continue
    const name = raw.trim().replace(/\s+/g, ' ')
    if (!name || name.length > 120 || known.has(normalize(name))) continue
    known.add(normalize(name))
    try { all.push(await createCategory(name)); created.push(name) }
    catch (error) { failed.push({ item: name, error: error instanceof Error ? error.message : 'Не вдалося створити категорію' }) }
  }
  return { categories: all, created, failed }
}

/** Перейменування категорій (переклад українською). Назву, яка вже є в іншої категорії, не дублюємо. */
export async function renameChatCategories(
  renames: ReadonlyArray<{ category_id?: unknown; new_name?: unknown }>,
  categories: readonly Category[],
  updateCategory: (id: string, name: string) => Promise<unknown>,
): Promise<{ renamed: number; skipped: ChatCatalogSkip[] }> {
  const byId = new Map(categories.map(category => [category.id, category]))
  const owner = new Map(categories.map(category => [normalize(category.name), category.id]))
  const skipped: ChatCatalogSkip[] = []
  let renamed = 0
  for (const row of renames) {
    const id = String(row?.category_id ?? '')
    const name = typeof row?.new_name === 'string' ? row.new_name.trim().replace(/\s+/g, ' ') : ''
    const current = byId.get(id)
    if (!current) { skipped.push({ item: name || id, error: 'Категорію не знайдено' }); continue }
    if (!name || name.length > 120) { skipped.push({ item: current.name, error: 'Порожня або задовга назва' }); continue }
    if (name === current.name) continue
    const taken = owner.get(normalize(name))
    if (taken && taken !== id) { skipped.push({ item: current.name, error: `Назва «${name}» вже є в іншої категорії — це дубль, обʼєднайте вручну` }); continue }
    try {
      await updateCategory(id, name)
      owner.delete(normalize(current.name)); owner.set(normalize(name), id)
      renamed += 1
    } catch (error) { skipped.push({ item: current.name, error: error instanceof Error ? error.message : 'Не вдалося перейменувати' }) }
  }
  return { renamed, skipped }
}

export async function applyChatCatalogUpdates(
  updates: readonly ChatCatalogUpdate[],
  bridge: ChatCatalogBridge,
  initialCategories: ReadonlyArray<Category>,
  operationId: (chunkIndex: number) => Promise<string>,
  createCategory?: (name: string) => Promise<Category>,
): Promise<{ updated: number; skipped: ChatCatalogSkip[]; unchanged: number; backupPath: string; createdCategories: string[] }> {
  const ids = [...new Set(updates.map(update => String(update?.product_id ?? '')).filter(Boolean))]
  if (!ids.length) throw new Error('У пропозиції немає товарів')
  const ensured = createCategory
    ? await ensureChatCategories(updates.map(update => update?.category_name), initialCategories, createCategory)
    : { categories: [...initialCategories], created: [] as string[], failed: [] as ChatCatalogSkip[] }
  const categories = ensured.categories
  const fingerprints: Fingerprint[] = []
  for (let start = 0; start < ids.length; start += 500) fingerprints.push(...await bridge.agentFingerprints(ids.slice(start, start + 500)))
  const plan = planChatCatalogUpdates(updates, fingerprints, categories)
  let updated = 0
  let backupPath = ''
  const skipped = [...ensured.failed, ...plan.skipped]
  // Одна пачка до 500 карток = одна резервна копія бази перед записом.
  for (let start = 0, chunk = 0; start < plan.items.length; start += 500, chunk += 1) {
    const result = await bridge.agentApply({ operation_id: await operationId(chunk), items: plan.items.slice(start, start + 500), skip_invalid: true })
    updated += Number(result.updated) || 0
    backupPath = result.backupPath ?? backupPath
    for (const row of result.skipped ?? []) skipped.push({ item: row.name, error: row.error })
  }
  return { updated, skipped, unchanged: plan.unchanged, backupPath, createdCategories: ensured.created }
}
