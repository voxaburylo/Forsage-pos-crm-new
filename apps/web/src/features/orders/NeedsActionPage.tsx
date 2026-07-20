import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FilePen, Phone, PackageCheck, Wallet, Clock, ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'
import { customerApi } from '@/features/customers/customerApi'
import { orderApi } from '@/features/orders/orderApi'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { Layout } from '@/components/Layout'
import { formatMoney } from '@/lib/utils'

// Зведений екран «Потребує дії» (ORD-25) — усі недотиснуті продажі в одному місці:
// чернетки, ліди, готові до видачі (незабрані), борги, лист очікування.

interface OrderLite {
  id: string
  status: string
  source: string
  total_amount: number
  total_paid: number
}

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
  const [loading, setLoading] = useState(true)
  const [cards, setCards] = useState<ActionCard[]>([])

  useEffect(() => {
    let alive = true
    async function load() {
      setLoading(true)
      const desktop = isDesktopRuntime()
      const localOrders = desktop ? await orderApi.list(0, { silent: true }, 1000).catch(() => ({ data: [] })) : null
      const [leadRes, readyRes, debtRes, waitRes] = await Promise.all([
        desktop
          ? Promise.resolve({ data: (localOrders?.data ?? []).filter((order) => order.status === 'lead') as OrderLite[] })
          : api.get<{ data: OrderLite[] }>('/api/v1/customer-orders?status=lead&per_page=200', { silent: true }).catch(() => ({ data: [] })),
        desktop
          ? Promise.resolve({ data: (localOrders?.data ?? []).filter((order) => order.status === 'ready') as OrderLite[] })
          : api.get<{ data: OrderLite[] }>('/api/v1/customer-orders?status=ready&per_page=200', { silent: true }).catch(() => ({ data: [] })),
        customerApi.list({ has_debt: 'true', sort: 'debt', per_page: 100 }).catch(() => null),
        desktop
          ? Promise.resolve({ data: [] as Array<{ status: string }> })
          : api.get<{ data: Array<{ status: string }> }>('/api/v1/waitlist', { silent: true }).catch(() => ({ data: [] })),
      ])
      if (!alive) return

      const leads = (leadRes as any).data ?? []
      const drafts = leads.filter((o: OrderLite) => o.source === 'walk_in' || o.source === 'mobile_draft')
      const pureLeads = leads.filter((o: OrderLite) => o.source !== 'walk_in' && o.source !== 'mobile_draft')
      const ready = (readyRes as any).data ?? []
      const debtors = debtRes?.data ?? []
      const debtSum = debtors.reduce((s: number, c: any) => s + (c.debt_balance ?? 0), 0)
      const waiting = ((waitRes as any).data ?? []).filter((w: any) => w.status === 'waiting')

      const next: ActionCard[] = [
        { key: 'ready', label: 'До видачі (незабрані)', hint: 'Товар готовий — подзвонити та видати', count: ready.length, icon: <PackageCheck size={20} />, color: 'green', to: '/orders?tab=ready' },
        { key: 'debts', label: 'Борги клієнтів', hint: 'Нагадати про оплату', count: debtors.length, extra: debtSum > 0 ? formatMoney(debtSum) : undefined, icon: <Wallet size={20} />, color: 'red', to: '/customers' },
        { key: 'drafts', label: 'Чернетки / КП', hint: 'Дотиснути до замовлення', count: drafts.length, icon: <FilePen size={20} />, color: 'purple', to: '/orders?tab=drafts' },
        { key: 'leads', label: 'Ліди', hint: 'Звʼязатися з клієнтом', count: pureLeads.length, icon: <Phone size={20} />, color: 'blue', to: '/orders?tab=leads' },
        { key: 'waitlist', label: 'Лист очікування', hint: 'Чекають надходження товару', count: waiting.length, icon: <Clock size={20} />, color: 'orange', to: '/waitlist' },
      ]
      setCards(next)
      setLoading(false)
    }
    load()
    return () => { alive = false }
  }, [])

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
          {loading ? 'Завантаження...' : totalPending === 0
            ? 'Усе під контролем — нічого не потребує дії 🎉'
            : `Всього потребує уваги: ${totalPending}`}
        </p>

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
