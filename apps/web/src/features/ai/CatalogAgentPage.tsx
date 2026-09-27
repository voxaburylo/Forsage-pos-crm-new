import { useEffect, useRef, useState } from 'react'
import { useAuthStore } from '@/stores/authStore'
import { Link } from 'react-router-dom'
import { Layout } from '@/components/Layout'
import { Button, Card, ConfirmDialog } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { desktopBridge } from '@/lib/desktopBridge'
import { formatMoney } from '@/lib/utils'
import { aiApi } from './aiApi'
import { catalogReviewIssues } from './catalogReviewValidation'
import { catalogAgentPayload, selectableAgentIssue, retainAgentReview, type CatalogIssue } from './catalogAgentModel'

type AgentProduct = { id: string; name: string; sku: string; brand: string; category_id: string | null; fingerprint: string }
type Scan = { products: AgentProduct[]; categories: Array<{ id: string; name: string }>; issues: CatalogIssue[]; total: number }
const labels: Record<string, string> = { all: 'Усі', name: 'Назви', sku: 'Артикули', category: 'Категорії', price: 'Націнка', duplicate: 'Дублі', ai: 'Пропозиції AI' }
const fields: Record<string, string> = { name: 'Назва', sku: 'Артикул', category_id: 'Категорія', retail_price: 'Ціна продажу' }
let reviewMemory: { userId: string; issues: CatalogIssue[]; reviewed: Record<string, string> } | null = null
export default function CatalogAgentPage() {
  const user = useAuthStore(state => state.session?.user)
  if (!user) return null
  const scope = JSON.stringify([user.id, user.app_metadata?.tenant_id ?? 'local'])
  return <CatalogAgentContent key={scope} userId={scope} />
}
function CatalogAgentContent({userId}:{userId:string}) {
  const [scan, setScan] = useState<Scan | null>(null)
  const [issues, setIssues] = useState<CatalogIssue[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('all')
  const [page, setPage] = useState(0)
  const [minMarkup, setMinMarkup] = useState('15')
  const [busy, setBusy] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [reviewed, setReviewed] = useState<Record<string, string>>({})
  const [runLimit, setRunLimit] = useState(100)
  const [error, setError] = useState('')
  const [lastResult, setLastResult] = useState('')
  const [confirm, setConfirm] = useState(false)
  const stop = useRef(false)
  const running = useRef(false)
  const mounted = useRef(true)
  const pending = useRef<{ key: string; input: any } | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stop.current = true } }, [])
  useEffect(() => { if (scan && userId) reviewMemory = { userId, issues, reviewed } }, [scan, userId, issues, reviewed])
  const checked = Object.keys(reviewed).length
  const bridge = desktopBridge()?.catalog
  async function load() {
    if (running.current || !mounted.current) return
    if (!bridge?.agentScan) { setError('Оновіть локальну програму, щоб користуватися AI-агентом.'); return }
    setBusy(true); setError('')
    try {
      running.current = true
      const result = await bridge.agentScan({ min_markup: Number(minMarkup) }) as Scan
      if (!mounted.current) return
      const saved = reviewMemory?.userId === userId ? reviewMemory : null
      const retained = retainAgentReview(result.products, saved?.issues ?? [], saved?.reviewed ?? {})
      setScan(result); setIssues([...result.issues, ...retained.issues]); setReviewed(retained.reviewed)
      setSelected(new Set()); setPage(0); pending.current = null
    } catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : 'Не вдалося перевірити каталог') }
    finally { running.current = false; if (mounted.current) setBusy(false) }
  }
  async function reviewAi() {
    if (!scan || running.current || !mounted.current) return
    running.current = true
    stop.current = false; setAiBusy(true); setError('')
    try {
      const remaining = scan.products.filter(p => reviewed[p.id] !== p.fingerprint).slice(0, runLimit)
      for (let offset = 0; offset < remaining.length && !stop.current; offset += 25) {
        const batch = remaining.slice(offset, offset + 25)
        const response = await aiApi.reviewCatalog({ products: batch.map(({ fingerprint: _fingerprint, ...product }) => product), categories: scan.categories })
        if (!mounted.current) return
        const additions = catalogReviewIssues(response.data.proposals, batch, scan.categories)
        setIssues(previous => [...previous.filter(row => !additions.some(a => a.id === row.id)), ...additions])
        setReviewed(previous => ({ ...previous, ...Object.fromEntries(batch.map(p => [p.id, p.fingerprint])) }))
      }
    } catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : 'AI-перевірку зупинено. Уже отримані пропозиції залишилися.') }
    finally { running.current = false; if (mounted.current) setAiBusy(false) }
  }
  async function apply() {
    if (!bridge?.agentApply || running.current || !mounted.current) return
    running.current = true
    setBusy(true); setError('')
    try {
      const items = catalogAgentPayload(issues.filter(row => selected.has(row.id)))
      const key = JSON.stringify(items)
      if (pending.current?.key !== key) pending.current = { key, input: { operation_id: crypto.randomUUID(), items } }
      const result = await bridge.agentApply(pending.current.input)
      pending.current = null
      if (!mounted.current) return
      setLastResult('Змінено товарів: ' + result.updated + '. Резервна копія: ' + result.backupPath)
      toast.success('Підтверджені зміни збережено локально')
      running.current = false
      await load()
    } catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : 'Запис не завершено. Повторіть ту саму операцію.') }
    finally { running.current = false; if (mounted.current) setBusy(false) }
  }
  const visible = issues.filter(row => filter === 'all' || row.kind === filter)
  const pages = Math.max(1, Math.ceil(visible.length / 50))
  const rows = visible.slice(page * 50, page * 50 + 50)
  const value = (key: string, val: any) => key === 'retail_price' ? formatMoney(Number(val)) : key === 'category_id' ? scan?.categories.find(c => c.id === val)?.name ?? 'Без категорії' : String(val ?? '—')
  return <Layout title="AI-агент">
    <div className="mb-4 flex flex-wrap gap-3 text-sm"><span className="border-b-2 border-yellow-400 pb-2 font-semibold">Порядок у товарах</span><Link className="pb-2 text-gray-600" to="/ai-assistant">Помічник / фото</Link><Link className="pb-2 text-gray-600" to="/audit">Журнал змін</Link></div>
    <Card className="mb-4">
      <h2 className="font-bold">Перевірити → переглянути → підтвердити</h2>
      <p className="mt-2 text-sm text-gray-600">Перевірка не змінює базу. Агент пропонує переклад назв, артикули з назв, наявні категорії та виправлення ціни за вашою таблицею. Схожий товар — не обов’язково дубль.</p>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-xs text-gray-600">Підозріла націнка нижче, %<input aria-label="Поріг націнки" value={minMarkup} onChange={e => setMinMarkup(e.target.value)} type="number" min="0" max="1000" disabled={busy || aiBusy} className="mt-1 block w-28 rounded border px-3 py-2 text-base" /></label>
        <Button onClick={load} disabled={busy || aiBusy} loading={busy}>Перевірити каталог</Button>
        <label className="text-xs text-gray-600">Товарів за один запуск<select aria-label="Розмір AI-перевірки" value={runLimit} disabled={busy || aiBusy} onChange={e => setRunLimit(Number(e.target.value))} className="mt-1 block rounded border px-3 py-2 text-base">{[25, 100, 500].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
        <Button variant="secondary" onClick={reviewAi} disabled={!scan || busy || aiBusy || checked >= (scan?.total ?? 0)}>AI: перевірити назви й категорії</Button>
        {aiBusy && <Button variant="secondary" onClick={() => { stop.current = true }}>Зупинити після запиту</Button>}
      </div>
      <p className="mt-2 text-xs text-gray-500">AI надсилає Gemini тільки назви, артикули, бренди та список категорій — по 25 товарів. Потрібен інтернет і налаштований ключ; діють ліміти вашого AI-акаунта. Залишки й ціни не передаються. Наступний запуск продовжує перевірку. При переході між вкладками завершені пропозиції зберігаються до закриття програми.</p>
      {scan && <p className="mt-3 text-sm">У каталозі: {scan.total}. Зауважень: {issues.length}. Перевірено AI: {checked} / {scan.total}{aiBusy ? ' — працює…' : ''}</p>}
    </Card>
    {error && <p role="alert" className="mb-4 rounded bg-red-50 p-3 text-sm text-red-800 [overflow-wrap:anywhere]">{error}</p>}
    {lastResult && <p className="mb-4 rounded bg-green-50 p-3 text-sm text-green-800 [overflow-wrap:anywhere]">{lastResult}</p>}
    <div className="mb-3 flex flex-wrap gap-2">{Object.entries(labels).map(([key, label]) => <button key={key} onClick={() => { setFilter(key); setPage(0) }} className={'rounded-lg border px-3 py-2 text-sm ' + (filter === key ? 'border-yellow-400 bg-yellow-50' : 'bg-white')}>{label} {key === 'all' ? issues.length : issues.filter(row => row.kind === key).length}</button>)}</div>
    <div className="mb-3 flex flex-wrap items-center gap-3"><Button disabled={!selected.size || busy || aiBusy} onClick={() => setConfirm(true)}>Переглянуто — застосувати ({selected.size})</Button>
      <button className="text-sm text-gray-500" onClick={() => setSelected(new Set())} disabled={busy}>Зняти вибір</button></div>
    <Card padding="none">
      {!scan ? <p className="p-6 text-sm text-gray-500">Натисніть «Перевірити каталог», щоб побачити зауваження.</p> : !rows.length ? <p className="p-6 text-sm text-gray-500">У цій групі зауважень немає. Це не гарантія відсутності всіх помилок.</p> : rows.map(row => <article key={row.id} className="border-b p-4 last:border-0">
        <div className="flex items-start gap-3"><input aria-label={'Підтвердити ' + row.name} type="checkbox" className="mt-1 h-5 w-5 shrink-0" disabled={busy || aiBusy || !selectableAgentIssue(row)} checked={selected.has(row.id)} onChange={e => setSelected(previous => { const next = new Set(previous); if (e.target.checked) next.add(row.id); else next.delete(row.id); return next })} />
          <div className="min-w-0 flex-1"><Link to={'/products/' + row.product_id + '/edit'} className="font-semibold text-gray-900 [overflow-wrap:anywhere]">{row.name}</Link><p className="text-xs text-gray-500 [overflow-wrap:anywhere]">{row.sku} · {labels[row.kind]}</p><p className="mt-2 text-sm text-gray-600">{row.reason}</p>
            {row.primary_id && <p className="mt-2 text-sm">Залишити: <Link className="underline" to={'/products/' + row.primary_id + '/edit'}>{row.primary_name} ({row.primary_sku})</Link>. {row.blocked ? 'Автоматичне вилучення заблоковане.' : 'Вилучити цю порожню картку з активного каталогу. Історія аудиту залишиться.'}</p>}
            {Object.entries(row.changes).map(([key, next]) => <div key={key} className="mt-2 grid gap-1 rounded bg-gray-50 p-2 text-sm sm:grid-cols-2"><span className="text-gray-500 [overflow-wrap:anywhere]">{fields[key]} було: {value(key, row.before?.[key])}</span><span className="font-medium [overflow-wrap:anywhere]">Стане: {value(key, next)}</span></div>)}
          </div></div>
      </article>)}
    </Card>
    <div className="mt-4 flex items-center justify-between gap-3"><Button variant="secondary" disabled={!page} onClick={() => setPage(p => p - 1)}>Назад</Button><span className="text-sm">{page + 1} / {pages}</span><Button variant="secondary" disabled={page + 1 >= pages} onClick={() => setPage(p => p + 1)}>Далі</Button></div>
    <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title="Застосувати перевірені зміни?" confirmLabel="Зберегти локально" onConfirm={apply}
      danger={issues.some(row => selected.has(row.id) && row.primary_id !== undefined)} message="Зміняться лише позначені поля. Ціни вплинуть на нові продажі; старі чеки не зміняться. Порожні підтверджені дублі будуть вилучені з активного каталогу. Перед записом буде резервна копія. Залишки не змінюються." />
  </Layout>
}
