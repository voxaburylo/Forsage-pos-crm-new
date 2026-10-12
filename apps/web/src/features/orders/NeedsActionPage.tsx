import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FilePen, Phone, PackageCheck, Wallet, Clock, ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'
import { customerApi } from '@/features/customers/customerApi'
import { orderApi } from '@/features/orders/orderApi'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'
import { Layout } from '@/components/Layout'
import { formatMoney } from '@/lib/utils'
import { ACTION_ROUTES, orderActionCounts, readActionPages } from './orderQueues'

// Зведений екран «Потребує дії» (ORD-25) — усі недотиснуті продажі в одному місці:
// чернетки, ліди, готові до видачі (незабрані), борги, лист очікування.

interface ActionCard {
  key: string
  label: string
  hint: string
  count: number
  extra?: string
  icon: React.ReactNode
  color: string
  to: string
}

export default function NeedsActionPage() {
  const navigate = useNavigate()
  const offlineMode = useAuthStore((state) => state.offlineMode)
  const [loading, setLoading] = useState(true)
  const [cards, setCards] = useState<ActionCard[]>([])
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let alive = true
    async function load() {
      setLoading(true)
      setLoadError('')
      const desktop = isDesktopRuntime()
      try {
      const [orders, debtors, waitRes] = await Promise.all([
        readActionPages(async (_page, offset) => {
          const result = await orderApi.list(offset, { silent: true }, 200, { status: 'lead,quoted,ready,arrived,called,no_answer' })
          return { data: result.data, hasMore: result.meta.has_more }
        }, () => alive),
        readActionPages(async page => {
          const result = await customerApi.list({ has_debt: 'true', sort: 'debt', per_page: 100, page })
          return { data: result.data, hasMore: page < result.pagination.total_pages }
        }, () => alive),
        desktop && offlineMode
          ? Promise.resolve({ data: [] as Array<{ status: string }> })
          : api.get<{ data: Array<{ status: string }> }>('/api/v1/waitlist', { silent: true }),
      ])
      if (!alive || !orders || !debtors) return
      const counts = orderActionCounts(orders)
      const debtSum = debtors.reduce((s: number, c: any) => s + (c.debt_balance ?? 0), 0)
      const waiting = ((waitRes as any).data ?? []).filter((w: any) => w.status === 'waiting')

      const next: ActionCard[] = [
        { key: 'ready', label: 'До видачі (незабрані)', hint: 'Товар готовий — подзвонити та видати', count: counts.ready, icon: <PackageCheck size={20} />, color: 'green', to: ACTION_ROUTES.ready },
        { key: 'debts', label: 'Борги клієнтів', hint: 'Нагадати про оплату', count: debtors.length, extra: debtSum > 0 ? formatMoney(debtSum) : undefined, icon: <Wallet size={20} />, color: 'red', to: ACTION_ROUTES.debts },
        { key: 'drafts', label: 'Чернетки / КП', hint: 'Дотиснути до замовлення', count: counts.drafts, icon: <FilePen size={20} />, color: 'purple', to: ACTION_ROUTES.drafts },
        { key: 'leads', label: 'Ліди', hint: 'Звʼязатися з клієнтом', count: counts.leads, icon: <Phone size={20} />, color: 'blue', to: ACTION_ROUTES.leads },
        { key: 'waitlist', label: 'Лист очікування', hint: 'Чекають надходження товару', count: waiting.length, icon: <Clock size={20} />, color: 'orange', to: ACTION_ROUTES.waitlist },
      ]
      setCards(next)
      } catch (error) {
        if (alive) { setCards([]); setLoadError(error instanceof Error ? error.message : 'Не вдалося завантажити підсумки') }
      } finally { if (alive) setLoading(false) }
    }
    load()
    return () => { alive = false }
  }, [offlineMode, reload])

  const COLORS: Record<string, string> = {
    green: 'bg-green-50 text-green-600',
    red: 'bg-red-50 text-red-600',
    purple: 'bg-purple-50 text-purple-600',
    blue: 'bg-blue-50 text-blue-600',
    orange: 'bg-orange-50 text-orange-600',
  }

  const totalPending = cards.reduce((s, c) => s + c.count, 0)

  return (
    <Layout title="Потребує дії">
      <div className="max-w-4xl space-y-4">
        <p className="text-sm text-gray-500">
          {loading ? 'Завантаження...' : loadError ? 'Підсумки недоступні' : totalPending === 0
            ? 'Усе під контролем — нічого не потребує дії 🎉'
            : `Всього потребує уваги: ${totalPending}`}
        </p>
        {loadError && <p role="alert" className="text-sm text-red-700">{loadError} <button onClick={() => setReload(value => value + 1)} className="underline">Повторити</button></p>}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {cards.map((c) => (
            <button
              key={c.key}
              onClick={() => navigate(c.to)}
              className="bg-white border border-gray-100 rounded-2xl p-5 shadow-sm hover:shadow-md transition-shadow flex items-center gap-4 text-left"
            >
              <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${COLORS[c.color]}`}>
                {c.icon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-extrabold text-gray-900">{c.count}</span>
                  {c.extra && <span className="text-sm font-bold text-red-500">{c.extra}</span>}
                </div>
                <p className="font-semibold text-gray-800 text-sm mt-0.5">{c.label}</p>
                <p className="text-xs text-gray-400">{c.hint}</p>
              </div>
              <ChevronRight size={18} className="text-gray-300 shrink-0" />
            </button>
          ))}
        </div>
      </div>
    </Layout>
  )
}
