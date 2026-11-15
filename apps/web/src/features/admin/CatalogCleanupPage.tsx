import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Layout } from '@/components/Layout'
import { Button, Card, Modal } from '@/components/ui'
import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import { readLanFirstRunStatus } from '@/lib/lanFirstRun'
import { formatMoney } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import {
  canCleanCatalog, cleanupApplyInput, cleanupFilterLabels, cleanupGroupsPage, cleanupLevelCounts, cleanupLevelLabels,
  cleanupScanAfterMerge, cleanupSelectionBlockers, cleanupSkuInput, defaultCleanupReason, manualCleanupGroup,
  MANUAL_GROUP_ID, retainCleanupOperation, searchCleanupProducts,
  type CleanupFilter, type CleanupGroup, type CleanupMergeInput, type CleanupOperation, type CleanupPreview,
  type CleanupProduct, type CleanupScan, type CleanupSkuSuggestion,
} from './catalogCleanupModel'

type AiReview = { group_id: string; verdict: 'same' | 'different' | 'uncertain'; reason: string }
type SkuInput = ReturnType<typeof cleanupSkuInput>
type Selection = { group: CleanupGroup; targetId: string; sourceIds: string[] }
const GROUPS_PER_PAGE = 8
const scopeOf = (id: string, tenant: unknown) => JSON.stringify([id, tenant ?? 'local'])
const messageOf = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback
const aiLabels = { same: 'ШІ вважає товари однаковими', different: 'ШІ бачить різні товари', uncertain: 'ШІ не впевнений' }
const levelTone: Record<CleanupGroup['level'], string> = { exact: 'bg-emerald-100 text-emerald-900', review: 'bg-amber-100 text-amber-900', conflict: 'bg-red-100 text-red-800' }

export default function CatalogCleanupPage() {
  const user = useAuthStore(state => state.session?.user)
  if (!user || !canCleanCatalog(user.app_metadata?.role)) return <Layout title="Очищення номенклатури"><p role="alert">Перевірка та об’єднання доступні лише власнику й адміністратору.</p></Layout>
  return <CleanupContent key={scopeOf(user.id, user.app_metadata?.tenant_id)} scope={scopeOf(user.id, user.app_metadata?.tenant_id)} />
}

function CleanupContent({ scope }: { scope: string }) {
  const [scan, setScan] = useState<CleanupScan | null>(null)
  const [busy, setBusy] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [filter, setFilter] = useState<CleanupFilter>('merge')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [skuPage, setSkuPage] = useState(0)
  const [excluded, setExcluded] = useState<Record<string, string[]>>({})
  const [manualIds, setManualIds] = useState<string[]>([])
  const [manualQuery, setManualQuery] = useState('')
  const [selection, setSelection] = useState<Selection | null>(null)
  const [preview, setPreview] = useState<CleanupPreview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [reason, setReason] = useState('')
  const [skuSelected, setSkuSelected] = useState<CleanupSkuSuggestion | null>(null)
  const [aiReviews, setAiReviews] = useState<Record<string, AiReview>>({})
  const [aiError, setAiError] = useState('')
  const [confirmError, setConfirmError] = useState('')
  const [runtimeGuard, setRuntimeGuard] = useState<'checking' | 'ready' | 'client' | 'unknown'>('checking')
  const running = useRef(false)
  const aiRunning = useRef(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  const pendingMerge = useRef<CleanupOperation<CleanupMergeInput> | null>(null)
  const pendingSku = useRef<CleanupOperation<SkuInput> | null>(null)
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++ } }, [])
  const isCurrent = useCallback(() => {
    const user = useAuthStore.getState().session?.user
    return mounted.current && !!user && canCleanCatalog(user.app_metadata?.role) && scopeOf(user.id, user.app_metadata?.tenant_id) === scope
  }, [scope])
  useEffect(() => {
    let cancelled = false
    void readLanFirstRunStatus().then(status => { if (!cancelled && isCurrent()) setRuntimeGuard(status?.mode === 'client' ? 'client' : status?.canPair ? 'unknown' : 'ready') })
      .catch(() => { if (!cancelled && isCurrent()) setRuntimeGuard('unknown') })
    return () => { cancelled = true }
  }, [isCurrent])
  const bridge = desktopBridge()?.catalog
  const productsById = useMemo(() => new Map(scan?.products.map(product => [product.id, product]) ?? []), [scan])
  const capabilityReason = scan && !scan.capability?.available ? scan.capability?.reason || 'Об’єднання недоступне в цій версії. Оновіть локальну програму.' : ''
  const canWrite = runtimeGuard === 'ready' && !!scan?.capability?.available && !!bridge?.cleanupApply
  const canWriteSku = runtimeGuard === 'ready' && !!bridge?.cleanupApplySku
  const disabled = busy || aiBusy || runtimeGuard !== 'ready'
  const confirmOpen = !!selection && !!preview

  function closeSelection() { setSelection(null); setPreview(null); setConfirmed(false); setReason(''); setConfirmError('') }
  async function load() {
    if (runtimeGuard !== 'ready' || running.current || aiRunning.current || !isCurrent()) return
    if (!bridge?.cleanupScan) { setError('Оновіть локальну програму для перевірки номенклатури.'); return }
    running.current = true; setBusy(true); setError('')
    const request = ++generation.current
    try {
      const next = await bridge.cleanupScan() as CleanupScan
      if (!isCurrent() || request !== generation.current) return
      if (!Array.isArray(next?.products) || !Array.isArray(next.groups) || !Array.isArray(next.sku_suggestions)) throw new Error('Отримано неповну перевірку каталогу. Оновіть програму й повторіть.')
      setScan(next); setPage(0); setSkuPage(0); closeSelection(); setExcluded({}); setManualIds([]); setManualQuery(''); setAiReviews({}); setAiError('')
    } catch (err) { if (isCurrent()) setError(messageOf(err, 'Не вдалося перевірити каталог.') + (scan ? ' На екрані попередні результати; нову перевірку не завершено.' : '')) }
    finally { running.current = false; if (isCurrent()) setBusy(false) }
  }
  /** Один клік «Залишити цю картку» = явний вибір основної; решта вибраних карток групи — дублі. */
  async function keep(group: CleanupGroup, targetId: string) {
    if (!scan || !canWrite || !bridge?.cleanupPreview || running.current || aiRunning.current || !isCurrent()) return
    const skipped = excluded[group.id] ?? []
    const sourceIds = group.product_ids.filter(id => id !== targetId && !skipped.includes(id))
    const blockers = cleanupSelectionBlockers(scan, group, targetId, sourceIds)
    setError(''); setResult(''); setConfirmError('')
    if (blockers.length) { setError(blockers.join(' ')); return }
    running.current = true; setBusy(true)
    const request = ++generation.current
    try {
      const response = await bridge.cleanupPreview({ target_id: targetId, source_ids: sourceIds, stock_review: 'pending' }) as CleanupPreview
      if (!isCurrent() || request !== generation.current) return
      setSelection({ group, targetId, sourceIds }); setPreview(response); setConfirmed(false); setReason(defaultCleanupReason(group))
    } catch (err) { if (isCurrent()) setError(messageOf(err, 'Не вдалося отримати свіжу перевірку об’єднання. Змін немає.')) }
    finally { running.current = false; if (isCurrent()) setBusy(false) }
  }
  async function applyMerge() {
    if (!scan || !selection || !preview || !confirmed || !canWrite || !bridge?.cleanupApply || running.current || !isCurrent()) return
    running.current = true; setBusy(true); setConfirmError('')
    try {
      const input = cleanupApplyInput(preview, selection.targetId, selection.sourceIds, reason)
      pendingMerge.current = retainCleanupOperation(pendingMerge.current, input)
      const saved = await bridge.cleanupApply(pendingMerge.current.input)
      if (!isCurrent()) return
      pendingMerge.current = null
      // Без нової перевірки всього каталогу: об'єднані картки просто зникають зі списку.
      setScan(cleanupScanAfterMerge(scan, selection.targetId, selection.sourceIds, preview.quantity_after))
      setManualIds(previous => previous.filter(id => id !== selection.targetId && !selection.sourceIds.includes(id)))
      closeSelection()
      setResult('Картки об’єднано. Облікову кількість збережено як суму карток; фактичний залишок не змінювали.' + (saved?.backupPath ? ' Резервна копія: ' + saved.backupPath : ''))
    } catch (err) { if (isCurrent()) setConfirmError(messageOf(err, 'Результат запису не підтверджено. Повторіть цей запит: його номер збережено.')) }
    finally { running.current = false; if (isCurrent()) setBusy(false) }
  }
  async function applySku() {
    if (!scan || !skuSelected || !confirmed || !canWriteSku || !bridge?.cleanupApplySku || running.current || !isCurrent()) return
    running.current = true; setBusy(true); setConfirmError('')
    try {
      const input = cleanupSkuInput(scan, skuSelected)
      pendingSku.current = retainCleanupOperation(pendingSku.current, input)
      const saved = await bridge.cleanupApplySku(pendingSku.current.input)
      if (!isCurrent()) return
      pendingSku.current = null; setSkuSelected(null)
      setResult('Підтверджений артикул записано. Назви, ціни й залишки не змінено.' + (saved?.backupPath ? ' Резервна копія: ' + saved.backupPath : ''))
      running.current = false; await load()
    } catch (err) { if (isCurrent()) setConfirmError(messageOf(err, 'Результат запису не підтверджено. Повторіть цей запит: його номер збережено.')) }
    finally { running.current = false; if (isCurrent()) setBusy(false) }
  }
  async function reviewAi(group: CleanupGroup) {
    const rows = group.product_ids.map(id => productsById.get(id)).filter((row): row is CleanupProduct => !!row)
    if (!rows.length || aiRunning.current || running.current || !isCurrent()) return
    aiRunning.current = true; setAiBusy(true); setAiError('')
    const request = generation.current
    try {
      const response = await api.post<{ data: { reviews: AiReview[] } }>('/api/v1/ai/catalog-duplicates-review', { groups: [{ id: group.id, products: rows.map(({ id, name, sku, barcode, additional_barcodes, brand, unit }) => ({ id, name, sku: sku ?? '', barcode: barcode ?? null, additional_barcodes: additional_barcodes ?? [], brand: brand ?? null, unit })) }] }, undefined, { silent: true, timeoutMs: 120000 })
      if (!isCurrent() || request !== generation.current) return
      const review = response.data.reviews.find(row => row.group_id === group.id)
      if (!review || !['same', 'different', 'uncertain'].includes(review.verdict) || !review.reason) throw new Error('ШІ не надав перевіреної відповіді для цієї групи.')
      setAiReviews(previous => ({ ...previous, [group.id]: review }))
    } catch (err) { if (isCurrent()) setAiError(messageOf(err, 'ШІ недоступний. Локальна перевірка й ваш вибір збережені.')) }
    finally { aiRunning.current = false; if (isCurrent()) setAiBusy(false) }
  }
  function toggle(groupId: string, productId: string) {
    setExcluded(previous => {
      const current = previous[groupId] ?? []
      return { ...previous, [groupId]: current.includes(productId) ? current.filter(id => id !== productId) : [...current, productId] }
    })
  }
  function addManual(ids: string[]) {
    setManualIds(previous => [...new Set([...previous, ...ids])].slice(0, 21)); setManualQuery(''); setError(''); setResult('')
  }

  const counts = scan ? cleanupLevelCounts(scan) : null
  const groupsPage = scan ? cleanupGroupsPage(scan, filter, query, page, GROUPS_PER_PAGE) : null
  const manualGroup = manualCleanupGroup(manualIds.filter(id => productsById.has(id)))
  const manualFound = scan ? searchCleanupProducts(scan, manualQuery, manualIds, 12) : []
  const skuRows = scan?.sku_suggestions.filter(row => {
    const product = productsById.get(row.product_id)
    return [product?.name, product?.sku, row.sku, product?.barcode, ...(product?.additional_barcodes ?? [])].join(' ').toLocaleLowerCase('uk').includes(query.toLocaleLowerCase('uk').trim())
  }) ?? []
  const skuPages = Math.max(1, Math.ceil(skuRows.length / 12))
  const safeSkuPage = Math.min(skuPage, skuPages - 1)
  const closeConfirm = () => { if (!running.current) { closeSelection(); setSkuSelected(null) } }
  const groupProps = { products: productsById, disabled, canWrite, onKeep: keep, onToggle: toggle, onAi: reviewAi, aiBusy }

  return <Layout title="Очищення номенклатури">
    <Card className="mb-4">
      <h2 className="font-semibold">Дублі карток товарів</h2>
      <p className="mt-2 text-sm text-gray-600">Програма шукає картки одного товару. Нічого не об’єднується само: ви обираєте, яку картку залишити, і підтверджуєте. Історія продажів і всі штрихкоди зберігаються, облікові залишки складаються.</p>
      <Button className="mt-3" onClick={load} disabled={disabled} loading={busy && !confirmOpen && !skuSelected}>{scan ? 'Перевірити знову' : 'Перевірити номенклатуру'}</Button>
      {runtimeGuard === 'client' && <p role="alert" className="mt-2 text-sm text-amber-900">Очищення номенклатури виконується лише на головному ПК магазину. На ПК менеджера каталог не об’єднується.</p>}
      {runtimeGuard === 'unknown' && <p role="alert" className="mt-2 text-sm text-amber-900">Не вдалося підтвердити режим головного ПК. Перевірку й запис заблоковано; перевірте налаштування підключення та відкрийте цей розділ знову.</p>}
      {scan && counts && <p className="mt-2 text-sm" data-cleanup-summary>Карток: {scan.total ?? scan.products.length}. Імовірних дублів: <strong>{counts.exact}</strong>, схожих: {counts.review}, суперечностей: {counts.conflict}.</p>}
    </Card>
    {error && <p role="alert" className="mb-3 rounded bg-red-50 p-3 text-red-800 [overflow-wrap:anywhere]">{error}</p>}
    {result && <p role="status" className="mb-3 rounded bg-green-50 p-3 text-sm text-green-800 [overflow-wrap:anywhere]">{result}</p>}
    {capabilityReason && <p role="alert" className="mb-3 rounded bg-amber-50 p-3 text-sm text-amber-900">{capabilityReason} Перегляд результатів і перевірка артикулів доступні; об’єднання заблоковано.</p>}
    {scan?.warnings?.map((warning, index) => <p key={index} className="mb-2 text-sm text-amber-800">{warning}</p>)}
    {aiError && <p role="alert" className="mb-3 text-sm text-red-700">{aiError}</p>}
    {scan && <>
      <div data-cleanup-manual><Card className="mb-4">
        <h2 className="font-semibold">Об’єднати вручну</h2>
        <p className="mt-1 text-sm text-gray-600">Якщо знаєте, що дві картки — один товар, знайдіть їх за назвою, артикулом або штрихкодом і додайте сюди.</p>
        <input className="mt-2 block w-full max-w-xl rounded border px-3 py-2" aria-label="Пошук картки для ручного об’єднання" value={manualQuery} disabled={disabled} onChange={e => setManualQuery(e.target.value)} placeholder="Наприклад: WA6684 або 5050026343761" />
        {manualQuery.trim().length >= 2 && !manualFound.length && <p className="mt-2 text-sm text-gray-500">Карток за цим запитом не знайдено.</p>}
        {manualFound.map(product => <div key={product.id} className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm">
          <span className="[overflow-wrap:anywhere]"><strong>{product.name}</strong> · арт. {product.sku || '—'} · {formatMoney(product.retail_price ?? 0)} · залишок {product.qty_on_hand}</span>
          <Button variant="secondary" disabled={disabled || manualIds.length >= 21} aria-label={'Додати до ручного об’єднання: ' + product.name} onClick={() => addManual([product.id])}>Додати</Button>
        </div>)}
        {manualGroup.product_ids.length > 0 && <div className="mt-3">
          {manualGroup.product_ids.length < 2 && <p className="mb-2 text-sm text-gray-600">Додайте ще принаймні одну картку.</p>}
          <GroupCard group={manualGroup} excluded={excluded[MANUAL_GROUP_ID] ?? []} {...groupProps} onRemove={id => setManualIds(previous => previous.filter(item => item !== id))} />
        </div>}
      </Card></div>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="text-sm">Показати<select className="mt-1 block rounded border px-3 py-2" aria-label="Рівень збігу" value={filter} onChange={e => { setFilter(e.target.value as CleanupFilter); setPage(0) }}>{Object.entries(cleanupFilterLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="text-sm">Пошук серед знайдених груп<input className="mt-1 block rounded border px-3 py-2" aria-label="Пошук серед результатів" value={query} onChange={e => { setQuery(e.target.value); setPage(0); setSkuPage(0) }} placeholder="Назва, бренд, артикул, штрихкод" /></label>
      </div>
      {!groupsPage?.rows.length ? <Card className="mb-4"><p className="text-sm text-gray-600">За цим фільтром груп не знайдено. Це не гарантія відсутності дублів.</p></Card>
        : groupsPage.rows.map(row => <div key={row.id} className="mb-3"><GroupCard group={row} excluded={excluded[row.id] ?? []} aiReview={aiReviews[row.id]} {...groupProps} onManual={ids => addManual(ids)} /></div>)}
      {!!groupsPage && <div className="mb-5 flex items-center justify-between gap-3"><Button variant="secondary" disabled={groupsPage.page === 0} onClick={() => setPage(groupsPage.page - 1)}>Попередні групи</Button><p className="text-sm">Груп: {groupsPage.total} · {groupsPage.page + 1} / {groupsPage.pages}</p><Button variant="secondary" disabled={groupsPage.page + 1 >= groupsPage.pages} onClick={() => setPage(groupsPage.page + 1)}>Наступні групи</Button></div>}
      <Card>
        <details data-cleanup-sku>
          <summary className="cursor-pointer font-semibold">Артикули з назв ({skuRows.length})</summary>
          <p className="mt-1 text-sm text-gray-600">Окрема операція: лише підтверджений артикул, без об’єднання карток або зміни кількості.</p>
          {!skuRows.length && <p className="mt-3 text-sm text-gray-500">Пропозицій за цим пошуком немає.</p>}
          {skuRows.slice(safeSkuPage * 12, safeSkuPage * 12 + 12).map(row => <article key={row.product_id + ':' + row.sku} className="mt-3 border-t pt-3">
            <p className="font-medium [overflow-wrap:anywhere]">{productsById.get(row.product_id)?.name ?? row.product_id}</p><p className="text-sm [overflow-wrap:anywhere]">Пропозиція: <strong>{row.sku}</strong>. {row.evidence}</p>{row.blocked && <p className="text-sm text-red-700">{row.blocked}</p>}
            <Button variant="secondary" className="mt-2" disabled={disabled || !canWriteSku || !!row.blocked} onClick={() => { setSkuSelected(row); setConfirmed(false); setConfirmError('') }}>Перевірити артикул</Button>
          </article>)}
          {skuPages > 1 && <div className="mt-3 flex items-center justify-between"><Button variant="secondary" disabled={!safeSkuPage} onClick={() => setSkuPage(safeSkuPage - 1)}>Попередні артикули</Button><span className="text-sm">{safeSkuPage + 1} / {skuPages}</span><Button variant="secondary" disabled={safeSkuPage + 1 >= skuPages} onClick={() => setSkuPage(safeSkuPage + 1)}>Наступні артикули</Button></div>}
        </details>
      </Card>
    </>}
    <Modal open={confirmOpen} onClose={closeConfirm} title="Підтвердити конкретне об’єднання" size="xl">
      {preview && selection && <>
        <p className="text-sm">Це свіжа перевірка вибраних карток. Якщо до запису вони зміняться, програма зупинить об’єднання.</p>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">{preview.products.map(product => <div key={product.id} className={'rounded border p-3 ' + (product.id === preview.target_id ? 'border-emerald-400 bg-emerald-50' : '')}><p className="mb-2 font-semibold">{product.id === preview.target_id ? 'Залишиться основною' : 'Буде об’єднано з основною'}</p><ProductComparison product={product} /></div>)}</div>
        <p className="mt-3 text-sm">Облікова кількість: {preview.quantity_before.join(' + ')} = <strong>{preview.quantity_after}</strong>. Фактичну кількість на полиці програма не перевіряє; за потреби проведіть ревізію.</p>
        <p className="mt-2 text-sm">Ціни після об’єднання — як в основній картці: продаж <strong>{formatMoney(preview.products.find(product => product.id === preview.target_id)?.retail_price ?? 0)}</strong>. Щоб залишити іншу ціну, скасуйте й оберіть основною іншу картку або змініть ціну в картці після об’єднання.</p>
        <p className="mt-2 text-sm [overflow-wrap:anywhere]">Штрихкоди після об’єднання: {preview.barcodes.join(', ') || 'немає'}.</p>
        {Object.keys(preview.history_counts ?? {}).length > 0 && <details className="mt-2 text-sm"><summary>Пов’язані записи документів</summary><pre className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{JSON.stringify(preview.history_counts, null, 2)}</pre></details>}
        {preview.warnings.map((item, index) => <p key={index} className="mt-2 text-sm text-amber-800">{item}</p>)}
        {preview.blockers.map((item, index) => <p role="alert" key={index} className="mt-2 text-sm text-red-700">{item}</p>)}
        <label className="mt-3 block text-sm">Причина об’єднання<textarea aria-label="Причина об’єднання" className="mt-1 block w-full rounded border p-2" rows={2} maxLength={1000} value={reason} disabled={busy} onChange={e => setReason(e.target.value)} /></label>
        <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" aria-label="Підтверджую однаковий товар" checked={confirmed} disabled={busy || !preview.can_apply || !!preview.blockers.length} onChange={e => setConfirmed(e.target.checked)} />Я порівняв назви, бренди, артикули та розміри: це один товар. Розумію, що облікова кількість сумується.</label>
        {confirmError && <p role="alert" className="mt-3 text-sm text-red-700">{confirmError} Повторне натискання повторить той самий запит без повторного об’єднання.</p>}
        <div className="mt-4 flex gap-3"><Button variant="danger" onClick={applyMerge} disabled={busy || !confirmed || !reason.trim() || !preview.can_apply || !!preview.blockers.length || !canWrite} loading={busy}>Підтвердити об’єднання</Button><Button variant="secondary" disabled={busy} onClick={closeConfirm}>Скасувати</Button></div>
      </>}
    </Modal>
    <Modal open={!!skuSelected} onClose={closeConfirm} title="Підтвердити артикул з назви">
      {skuSelected && <><p className="text-sm [overflow-wrap:anywhere]">{productsById.get(skuSelected.product_id)?.name}</p><p className="mt-2 text-sm">Артикул: <strong>{skuSelected.sku}</strong></p><p className="mt-2 text-sm">Доказ: {skuSelected.evidence}</p><p className="mt-2 text-sm text-gray-600">Перед записом перевіряються свіжість картки й зайнятість коду. Назви, ціни й залишки не змінюються.</p><label className="mt-4 flex gap-2 text-sm"><input type="checkbox" aria-label="Підтверджую артикул" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />Артикул перевірено мною.</label>{confirmError && <p role="alert" className="mt-3 text-sm text-red-700">{confirmError}</p>}<div className="mt-4 flex gap-3"><Button disabled={busy || !confirmed || !canWriteSku} loading={busy} onClick={applySku}>Зберегти артикул</Button><Button variant="secondary" disabled={busy} onClick={closeConfirm}>Скасувати</Button></div></>}
    </Modal>
  </Layout>
}

interface GroupCardProps {
  group: CleanupGroup; products: Map<string, CleanupProduct>; excluded: string[]; disabled: boolean; canWrite: boolean; aiBusy: boolean
  aiReview?: AiReview
  onKeep: (group: CleanupGroup, targetId: string) => void
  onToggle: (groupId: string, productId: string) => void
  onAi: (group: CleanupGroup) => void
  onRemove?: (productId: string) => void
  onManual?: (productIds: string[]) => void
}

/** Картки групи поруч, з цінами й залишками: порівняти й обрати можна одразу, без переходів. */
function GroupCard({ group, products, excluded, disabled, canWrite, aiBusy, aiReview, onKeep, onToggle, onAi, onRemove, onManual }: GroupCardProps) {
  const rows = group.product_ids.map(id => products.get(id)).filter((row): row is CleanupProduct => !!row)
  const conflict = group.level === 'conflict', manual = !!onRemove
  const prices = new Set(rows.map(row => row.retail_price ?? 0))
  return <div data-cleanup-group={group.id} data-cleanup-level={group.level}><Card>
    <div className="flex flex-wrap items-center gap-2">
      <span className={'rounded px-2 py-0.5 text-xs font-semibold ' + levelTone[group.level]}>{manual ? 'Вибрано вручну' : cleanupLevelLabels[group.level]}</span>
      <span className="text-sm text-gray-600">{rows.length} картки{prices.size > 1 ? ' · ціни різні' : ''}</span>
    </div>
    <div className="mt-3 grid gap-3 lg:grid-cols-2">{rows.map(product => {
      const skipped = excluded.includes(product.id)
      return <div key={product.id} className={'rounded border p-3 ' + (skipped ? 'opacity-60' : '')}>
        <ProductComparison product={product} />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button onClick={() => onKeep(group, product.id)} disabled={disabled || !canWrite || conflict || skipped || rows.length < 2} aria-label={'Залишити основною: ' + product.name}>Залишити цю картку</Button>
          {rows.length > 2 && !conflict && <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={'Об’єднати картку: ' + product.name} checked={!skipped} disabled={disabled} onChange={() => onToggle(group.id, product.id)} />об’єднувати</label>}
          {onRemove && <button type="button" className="text-sm text-gray-600 underline" disabled={disabled} onClick={() => onRemove(product.id)}>Прибрати</button>}
        </div>
      </div>
    })}</div>
    {conflict && <div className="mt-3 rounded bg-red-50 p-3 text-sm text-red-800">
      {group.conflicts.map((item, index) => <p key={index}>{item}</p>)}
      <p className="mt-1 text-red-900">Програма вважає ці картки різними товарами, тому тут об’єднання вимкнено.</p>
      {onManual && <button type="button" className="mt-1 underline" disabled={disabled} onClick={() => onManual(group.product_ids)}>Це той самий товар — перенести в ручне об’єднання</button>}
    </div>}
    {!manual && <details className="mt-3 text-sm text-gray-600">
      <summary className="cursor-pointer">Чому програма звела ці картки</summary>
      <ul className="mt-1 list-disc pl-5">{group.reasons.map((item, index) => <li key={index}>{item}</li>)}</ul>
      <div className="mt-2"><Button variant="secondary" onClick={() => onAi(group)} disabled={disabled || rows.length > 20} loading={aiBusy}>ШІ: перевірити цю групу</Button><p className="mt-1">Окремий запит до підключеного ШІ: лише назви, бренди, артикули, штрихкоди й одиниці цих карток. Потрібен інтернет. Порада ШІ не підтверджує об’єднання та не скасовує блокування.</p></div>
    </details>}
    {aiReview && <p className="mt-2 text-sm [overflow-wrap:anywhere]"><strong>{aiLabels[aiReview.verdict]}.</strong> {aiReview.reason}</p>}
  </Card></div>
}

function ProductComparison({ product }: { product: CleanupProduct }) {
  return <>
    <Link to={'/products/' + product.id + '/edit'} className="block whitespace-normal font-semibold underline [overflow-wrap:anywhere]">{product.name}</Link>
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm [overflow-wrap:anywhere]">
      {product.retail_price !== undefined && <><dt className="text-gray-500">Продаж</dt><dd className="font-semibold">{formatMoney(product.retail_price)}</dd></>}
      {product.purchase_price !== undefined && <><dt className="text-gray-500">Закупівля</dt><dd>{formatMoney(product.purchase_price)}</dd></>}
      <dt className="text-gray-500">Обліковий залишок</dt><dd className={product.qty_on_hand > 0 ? 'font-semibold' : ''}>{product.qty_on_hand} {product.unit}</dd>
      <dt className="text-gray-500">Артикул</dt><dd>{product.sku || 'не зазначено'}</dd>
      <dt className="text-gray-500">Штрихкоди</dt><dd>{[product.barcode, ...(product.additional_barcodes ?? [])].filter(Boolean).join(', ') || 'немає'}</dd>
      <dt className="text-gray-500">Бренд</dt><dd>{product.brand || 'не зазначено'}</dd>
      {product.notes && <><dt className="text-gray-500">Примітки</dt><dd className="whitespace-pre-wrap">{product.notes}</dd></>}
    </dl>
  </>
}
