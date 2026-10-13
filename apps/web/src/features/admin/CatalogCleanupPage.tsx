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
  canCleanCatalog, cleanupApplyInput, cleanupGroupsPage, cleanupLevelLabels, cleanupSelectionBlockers,
  cleanupSkuInput, retainCleanupOperation, type CleanupGroup, type CleanupMergeInput,
  type CleanupOperation, type CleanupPreview, type CleanupProduct, type CleanupScan, type CleanupSkuSuggestion,
} from './catalogCleanupModel'

type AiReview = { group_id: string; verdict: 'same' | 'different' | 'uncertain'; reason: string }
type SkuInput = ReturnType<typeof cleanupSkuInput>
const scopeOf = (id: string, tenant: unknown) => JSON.stringify([id, tenant ?? 'local'])
const messageOf = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback
const aiLabels = { same: 'ШІ вважає товари однаковими', different: 'ШІ бачить різні товари', uncertain: 'ШІ не впевнений' }

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
  const [filter, setFilter] = useState<'all' | CleanupGroup['level']>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [skuPage, setSkuPage] = useState(0)
  const [groupId, setGroupId] = useState('')
  const [targetId, setTargetId] = useState('')
  const [sourceIds, setSourceIds] = useState<string[]>([])
  const [stockReviewed, setStockReviewed] = useState(false)
  const [preview, setPreview] = useState<CleanupPreview | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
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
  const group = scan?.groups.find(row => row.id === groupId)
  const selectedProducts = group ? group.product_ids.map(id => productsById.get(id)).filter((row): row is CleanupProduct => !!row) : []
  const blockers = scan && group ? cleanupSelectionBlockers(scan, group, targetId, sourceIds) : []
  const capabilityReason = scan && !scan.capability?.available ? scan.capability?.reason || 'Об’єднання недоступне в цій версії. Оновіть локальну програму.' : ''
  const canWrite = runtimeGuard === 'ready' && !!scan?.capability?.available && !!bridge?.cleanupApply
  const canWriteSku = runtimeGuard === 'ready' && !!bridge?.cleanupApplySku
  const disabled = busy || aiBusy || runtimeGuard !== 'ready'

  function resetSelection() {
    setGroupId(''); setTargetId(''); setSourceIds([]); setStockReviewed(false); setPreview(null); setReason(''); setConfirmed(false)
  }
  async function load() {
    if (runtimeGuard !== 'ready' || running.current || aiRunning.current || !isCurrent()) return
    if (!bridge?.cleanupScan) { setError('Оновіть локальну програму для перевірки номенклатури.'); return }
    running.current = true; setBusy(true); setError('')
    const request = ++generation.current
    try {
      const next = await bridge.cleanupScan() as CleanupScan
      if (!isCurrent() || request !== generation.current) return
      if (!Array.isArray(next?.products) || !Array.isArray(next.groups) || !Array.isArray(next.sku_suggestions)) throw new Error('Отримано неповну перевірку каталогу. Оновіть програму й повторіть.')
      setScan(next); setPage(0); setSkuPage(0); resetSelection(); setAiReviews({}); setAiError('')
    } catch (err) { if (isCurrent()) setError(messageOf(err, 'Не вдалося перевірити каталог.') + (scan ? ' На екрані попередні результати; нову перевірку не завершено.' : '')) }
    finally { running.current = false; if (isCurrent()) setBusy(false) }
  }
  function selectGroup(id: string) {
    if (running.current || aiRunning.current) return
    generation.current++; resetSelection(); setGroupId(id); setAiError(''); setError('')
  }
  async function readPreview() {
    if (!scan || !group || blockers.length || !canWrite || !bridge?.cleanupPreview || running.current || !isCurrent()) return
    running.current = true; setBusy(true); setError(''); setConfirmError('')
    const request = generation.current
    try {
      const response = await bridge.cleanupPreview({ target_id: targetId, source_ids: sourceIds, stock_review: stockReviewed ? 'checked' : 'pending' }) as CleanupPreview
      if (!isCurrent() || request !== generation.current) return
      setPreview(response); setConfirmed(false); setConfirmOpen(true)
    } catch (err) { if (isCurrent()) setError(messageOf(err, 'Не вдалося отримати свіжу перевірку об’єднання. Змін немає.')) }
    finally { running.current = false; if (isCurrent()) setBusy(false) }
  }
  async function applyMerge() {
    if (!preview || !confirmed || !canWrite || !bridge?.cleanupApply || running.current || !isCurrent()) return
    running.current = true; setBusy(true); setConfirmError('')
    try {
      const input = cleanupApplyInput(preview, targetId, sourceIds, reason)
      pendingMerge.current = retainCleanupOperation(pendingMerge.current, input)
      const saved = await bridge.cleanupApply(pendingMerge.current.input)
      if (!isCurrent()) return
      pendingMerge.current = null; setConfirmOpen(false); setPreview(null)
      setResult('Картки об’єднано. Облікову кількість збережено як суму карток; фактичний залишок не змінювали.' + (saved?.backupPath ? ' Резервна копія: ' + saved.backupPath : ''))
      running.current = false; await load()
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
  async function reviewAi() {
    if (!group || !selectedProducts.length || aiRunning.current || running.current || !isCurrent()) return
    aiRunning.current = true; setAiBusy(true); setAiError('')
    const request = generation.current
    try {
      const response = await api.post<{ data: { reviews: AiReview[] } }>('/api/v1/ai/catalog-duplicates-review', { groups: [{ id: group.id, products: selectedProducts.map(({ id, name, sku, barcode, additional_barcodes, brand, unit }) => ({ id, name, sku: sku ?? '', barcode: barcode ?? null, additional_barcodes: additional_barcodes ?? [], brand: brand ?? null, unit })) }] }, undefined, { silent: true, timeoutMs: 120000 })
      if (!isCurrent() || request !== generation.current) return
      const review = response.data.reviews.find(row => row.group_id === group.id)
      if (!review || !['same', 'different', 'uncertain'].includes(review.verdict) || !review.reason) throw new Error('ШІ не надав перевіреної відповіді для цієї групи.')
      setAiReviews(previous => ({ ...previous, [group.id]: review }))
    } catch (err) { if (isCurrent()) setAiError(messageOf(err, 'ШІ недоступний. Локальна перевірка й ваш вибір збережені.')) }
    finally { aiRunning.current = false; if (isCurrent()) setAiBusy(false) }
  }
  const groupsPage = scan ? cleanupGroupsPage(scan, filter, query, page) : null
  const skuRows = scan?.sku_suggestions.filter(row => {
    const product = productsById.get(row.product_id)
    return [product?.name, product?.sku, row.sku, product?.barcode, ...(product?.additional_barcodes ?? [])].join(' ').toLocaleLowerCase('uk').includes(query.toLocaleLowerCase('uk').trim())
  }) ?? []
  const skuPages = Math.max(1, Math.ceil(skuRows.length / 12))
  const safeSkuPage = Math.min(skuPage, skuPages - 1)
  const closeConfirm = () => { if (!running.current) { setConfirmOpen(false); setSkuSelected(null); setConfirmError('') } }

  return <Layout title="Очищення номенклатури">
    <Card className="mb-4">
      <h2 className="font-semibold">Перевірка карток без автоматичного об’єднання</h2>
      <p className="mt-2 text-sm text-gray-600">Локальний пошук порівнює ознаки товарів. Навіть точний збіг за ознаками потребує вашого підтвердження. Назви й артикули самі по собі не доводять, що це один товар.</p>
      <p className="mt-2 text-sm text-gray-600">Об’єднання зберігає суму облікових залишків. Воно не виправляє фактичну кількість: для цього є <Link to="/inventory" className="underline">інвентаризація</Link>.</p>
      <Button className="mt-3" onClick={load} disabled={disabled} loading={busy && !confirmOpen && !skuSelected}>Перевірити номенклатуру</Button>
      {runtimeGuard === 'client' && <p role="alert" className="mt-2 text-sm text-amber-900">Очищення номенклатури виконується лише на головному ПК магазину. На ПК менеджера каталог не об’єднується.</p>}
      {runtimeGuard === 'unknown' && <p role="alert" className="mt-2 text-sm text-amber-900">Не вдалося підтвердити режим головного ПК. Перевірку й запис заблоковано; перевірте налаштування підключення та відкрийте цей розділ знову.</p>}
      {scan && <p className="mt-2 text-sm">Перевірено карток: {scan.total ?? scan.products.length}. Груп: {scan.groups.length}. Пропозицій артикулів: {scan.sku_suggestions.length}.</p>}
    </Card>
    {error && <p role="alert" className="mb-3 rounded bg-red-50 p-3 text-red-800 [overflow-wrap:anywhere]">{error}</p>}
    {result && <p role="status" className="mb-3 rounded bg-green-50 p-3 text-sm text-green-800 [overflow-wrap:anywhere]">{result}</p>}
    {capabilityReason && <p role="alert" className="mb-3 rounded bg-amber-50 p-3 text-sm text-amber-900">{capabilityReason} Перегляд результатів і перевірка артикулів доступні; об’єднання заблоковано.</p>}
    {scan?.warnings?.map((warning, index) => <p key={index} className="mb-2 text-sm text-amber-800">{warning}</p>)}
    {scan && <>
      <div className="mb-3 flex flex-wrap gap-3">
        <label className="text-sm">Пошук<input className="mt-1 block rounded border px-3 py-2" aria-label="Пошук серед результатів" value={query} onChange={e => { setQuery(e.target.value); setPage(0); setSkuPage(0) }} placeholder="Назва, бренд, артикул, штрихкод" /></label>
        <label className="text-sm">Групи<select className="mt-1 block rounded border px-3 py-2" aria-label="Рівень збігу" value={filter} onChange={e => { setFilter(e.target.value as typeof filter); setPage(0) }}><option value="all">Усі</option>{Object.entries(cleanupLevelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      <Card padding="none" className="mb-4">
        {!groupsPage?.rows.length ? <p className="p-4 text-sm text-gray-600">За цим фільтром груп не знайдено. Це не гарантія відсутності дублів.</p> : groupsPage.rows.map(row => <article key={row.id} className={'border-b p-4 last:border-0 ' + (row.id === groupId ? 'bg-yellow-50' : '')}>
          <p className={'font-semibold ' + (row.level === 'conflict' ? 'text-red-700' : 'text-gray-900')}>{cleanupLevelLabels[row.level]} · {row.product_ids.length} картки</p>
          {row.product_ids.map(id => <p key={id} className="mt-1 whitespace-normal text-sm [overflow-wrap:anywhere]">{scan.products.find(p => p.id === id)?.name ?? 'Картку не завантажено: ' + id}</p>)}
          <ul className="my-2 list-disc pl-5 text-sm text-gray-600">{row.reasons.map((item, index) => <li key={index}>{item}</li>)}</ul>
          {row.conflicts.map((item, index) => <p key={index} className="text-sm text-red-700">{item}</p>)}
          <Button variant="secondary" onClick={() => selectGroup(row.id)} disabled={disabled}>Порівняти картки</Button>
        </article>)}
      </Card>
      {!!groupsPage && <div className="mb-5 flex items-center justify-between gap-3"><Button variant="secondary" disabled={groupsPage.page === 0} onClick={() => setPage(groupsPage.page - 1)}>Попередні групи</Button><p className="text-sm">Груп: {groupsPage.total} · {groupsPage.page + 1} / {groupsPage.pages}</p><Button variant="secondary" disabled={groupsPage.page + 1 >= groupsPage.pages} onClick={() => setPage(groupsPage.page + 1)}>Наступні групи</Button></div>}
      {group && <Card className="mb-5">
        <h2 className="font-semibold">Порівняння карток</h2>
        <p className="mt-1 text-sm text-gray-600">Оберіть основну картку, яку залишити, та окремо позначте підтверджені дублі. Нічого не вибрано за вас.</p>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">{selectedProducts.map(product => <div key={product.id} className="rounded border p-3">
          <ProductComparison product={product} />
          <label className="mt-3 flex items-start gap-2 text-sm"><input type="radio" name="cleanup-target" aria-label={'Основна картка: ' + product.name} checked={targetId === product.id} disabled={disabled || group.level === 'conflict'} onChange={() => { setTargetId(product.id); setSourceIds(previous => previous.filter(id => id !== product.id)); setStockReviewed(false); setPreview(null) }} />Залишити основною</label>
          <label className="mt-2 flex items-start gap-2 text-sm"><input type="checkbox" aria-label={'Об’єднати картку: ' + product.name} checked={sourceIds.includes(product.id)} disabled={disabled || product.id === targetId || group.level === 'conflict'} onChange={event => { setSourceIds(previous => event.target.checked ? [...previous, product.id] : previous.filter(id => id !== product.id)); setStockReviewed(false); setPreview(null) }} />Об’єднати з основною</label>
        </div>)}</div>
        <div className="mt-4 rounded bg-gray-50 p-3 text-sm"><Button variant="secondary" onClick={reviewAi} disabled={disabled || selectedProducts.length > 20} loading={aiBusy}>ШІ: перевірити цю групу</Button><p className="mt-2 text-gray-600">Окремий запит до підключеного ШІ: лише назви, бренди, артикули, штрихкоди й одиниці цих карток. Потрібен інтернет, діють ліміти AI-акаунта. Порада ШІ не підтверджує об’єднання та не скасовує блокування.</p>{selectedProducts.length > 20 && <p className="mt-2 text-amber-800">ШІ перевіряє до 20 карток в одній групі. Цю більшу групу порівняйте вручну.</p>}{aiError && <p role="alert" className="mt-2 text-red-700">{aiError}</p>}{aiReviews[group.id] && <p className="mt-2 [overflow-wrap:anywhere]"><strong>{aiLabels[aiReviews[group.id].verdict]}.</strong> {aiReviews[group.id].reason}</p>}</div>
        <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" checked={stockReviewed} disabled={disabled} onChange={e => { setStockReviewed(e.target.checked); setPreview(null) }} />Я окремо звірив фактичну кількість із сумою облікових залишків вибраних карток. Ця позначка не змінює кількість.</label>
        <label className="mt-3 block text-sm">Причина об’єднання<textarea aria-label="Причина об’єднання" className="mt-1 block w-full rounded border p-2" maxLength={1000} value={reason} disabled={disabled} onChange={e => setReason(e.target.value)} /></label>
        {!!blockers.length && <ul className="mt-3 list-disc pl-5 text-sm text-red-700">{blockers.map((item, index) => <li key={index}>{item}</li>)}</ul>}
        <Button className="mt-3" onClick={readPreview} disabled={disabled || !canWrite || !!blockers.length || !reason.trim()}>Перевірити об’єднання</Button>
      </Card>}
      <Card>
        <h2 className="font-semibold">Артикули з назв</h2>
        <p className="mt-1 text-sm text-gray-600">Окрема операція: лише підтверджений артикул, без об’єднання карток або зміни кількості.</p>
        {!skuRows.length && <p className="mt-3 text-sm text-gray-500">Пропозицій за цим пошуком немає.</p>}
        {skuRows.slice(safeSkuPage * 12, safeSkuPage * 12 + 12).map(row => <article key={row.product_id + ':' + row.sku} className="mt-3 border-t pt-3">
          <p className="font-medium [overflow-wrap:anywhere]">{scan.products.find(p => p.id === row.product_id)?.name ?? row.product_id}</p><p className="text-sm [overflow-wrap:anywhere]">Пропозиція: <strong>{row.sku}</strong>. {row.evidence}</p>{row.blocked && <p className="text-sm text-red-700">{row.blocked}</p>}
          <Button variant="secondary" className="mt-2" disabled={disabled || !canWriteSku || !!row.blocked} onClick={() => { setSkuSelected(row); setConfirmed(false); setConfirmError('') }}>Перевірити артикул</Button>
        </article>)}
        {skuPages > 1 && <div className="mt-3 flex items-center justify-between"><Button variant="secondary" disabled={!safeSkuPage} onClick={() => setSkuPage(safeSkuPage - 1)}>Попередні артикули</Button><span className="text-sm">{safeSkuPage + 1} / {skuPages}</span><Button variant="secondary" disabled={safeSkuPage + 1 >= skuPages} onClick={() => setSkuPage(safeSkuPage + 1)}>Наступні артикули</Button></div>}
      </Card>
    </>}
    <Modal open={confirmOpen && !!preview} onClose={closeConfirm} title="Підтвердити конкретне об’єднання" size="xl">
      {preview && <>
        <p className="text-sm">Це свіжа перевірка вибраних карток. Якщо до запису вони зміняться, програма зупинить об’єднання.</p>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">{preview.products.map(product => <div key={product.id} className="rounded border p-3"><p className="mb-2 font-semibold">{product.id === preview.target_id ? 'Залишиться основною' : 'Буде об’єднано з основною'}</p><ProductComparison product={product} /></div>)}</div>
        <p className="mt-3 text-sm">Облікова кількість: {preview.quantity_before.join(' + ')} = <strong>{preview.quantity_after}</strong>. {preview.stock_review === 'checked' ? 'Фактичну кількість позначено перевіреною вами.' : 'Фактичну кількість ще не перевірено; за потреби проведіть окрему ревізію.'}</p>
        <p className="mt-2 text-sm [overflow-wrap:anywhere]">Штрихкоди після об’єднання: {preview.barcodes.join(', ') || 'немає'}.</p>
        {Object.keys(preview.history_counts ?? {}).length > 0 && <details className="mt-2 text-sm"><summary>Пов’язані записи документів</summary><pre className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{JSON.stringify(preview.history_counts, null, 2)}</pre></details>}
        {preview.warnings.map((item, index) => <p key={index} className="mt-2 text-sm text-amber-800">{item}</p>)}
        {preview.blockers.map((item, index) => <p role="alert" key={index} className="mt-2 text-sm text-red-700">{item}</p>)}
        <p className="mt-2 text-sm [overflow-wrap:anywhere]">Причина: {reason}</p>
        <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" aria-label="Підтверджую однаковий товар" checked={confirmed} disabled={busy || !preview.can_apply || !!preview.blockers.length} onChange={e => setConfirmed(e.target.checked)} />Я порівняв повні назви, бренди, артикули та розміри: вибрані картки — один товар. Розумію, що облікова кількість сумується.</label>
        {confirmError && <p role="alert" className="mt-3 text-sm text-red-700">{confirmError} Повторне натискання повторить той самий запит без повторного об’єднання.</p>}
        <div className="mt-4 flex gap-3"><Button variant="danger" onClick={applyMerge} disabled={busy || !confirmed || !preview.can_apply || !!preview.blockers.length || !canWrite} loading={busy}>Підтвердити об’єднання</Button><Button variant="secondary" disabled={busy} onClick={closeConfirm}>Скасувати</Button></div>
      </>}
    </Modal>
    <Modal open={!!skuSelected} onClose={closeConfirm} title="Підтвердити артикул з назви">
      {skuSelected && <><p className="text-sm [overflow-wrap:anywhere]">{scan?.products.find(p => p.id === skuSelected.product_id)?.name}</p><p className="mt-2 text-sm">Артикул: <strong>{skuSelected.sku}</strong></p><p className="mt-2 text-sm">Доказ: {skuSelected.evidence}</p><p className="mt-2 text-sm text-gray-600">Перед записом перевіряються свіжість картки й зайнятість коду. Назви, ціни й залишки не змінюються.</p><label className="mt-4 flex gap-2 text-sm"><input type="checkbox" aria-label="Підтверджую артикул" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />Артикул перевірено мною.</label>{confirmError && <p role="alert" className="mt-3 text-sm text-red-700">{confirmError}</p>}<div className="mt-4 flex gap-3"><Button disabled={busy || !confirmed || !canWriteSku} loading={busy} onClick={applySku}>Зберегти артикул</Button><Button variant="secondary" disabled={busy} onClick={closeConfirm}>Скасувати</Button></div></>}
    </Modal>
  </Layout>
}

function ProductComparison({ product }: { product: CleanupProduct }) {
  return <>
    <Link to={'/products/' + product.id + '/edit'} className="block whitespace-normal font-semibold underline [overflow-wrap:anywhere]">{product.name}</Link>
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm [overflow-wrap:anywhere]">
      <dt className="text-gray-500">Бренд</dt><dd>{product.brand || 'не зазначено'}</dd>
      <dt className="text-gray-500">Артикул</dt><dd>{product.sku || 'не зазначено'}</dd>
      <dt className="text-gray-500">Штрихкоди</dt><dd>{[product.barcode, ...(product.additional_barcodes ?? [])].filter(Boolean).join(', ') || 'немає'}</dd>
      <dt className="text-gray-500">Обліковий залишок</dt><dd>{product.qty_on_hand} {product.unit}</dd>
      {product.purchase_price !== undefined && <><dt className="text-gray-500">Закупівля</dt><dd>{formatMoney(product.purchase_price)}</dd></>}
      {product.retail_price !== undefined && <><dt className="text-gray-500">Продаж</dt><dd>{formatMoney(product.retail_price)}</dd></>}
      {product.notes && <><dt className="text-gray-500">Примітки</dt><dd className="whitespace-pre-wrap">{product.notes}</dd></>}
    </dl>
  </>
}
