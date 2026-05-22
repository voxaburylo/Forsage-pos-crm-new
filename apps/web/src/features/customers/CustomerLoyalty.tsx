import { useState, useEffect, useCallback } from 'react'
import { Star } from 'lucide-react'
import { api } from '@/lib/api'
import { formatMoney, formatDate } from '@/lib/utils'
import { toast } from '@/components/ui/Toast'

interface Transaction {
  id:             string
  type:           'accrual' | 'redemption' | 'expiry' | 'correction'
  amount_kopecks: number
  created_at:     string
  note:           string | null
}

const TYPE_LABEL: Record<string, string> = {
  accrual:    'Нарахування',
  redemption: 'Списання',
  expiry:     'Згоряння',
  correction: 'Коригування',
}
const TYPE_COLOR: Record<string, string> = {
  accrual:    'text-green-600',
  redemption: 'text-red-500',
  expiry:     'text-gray-400',
  correction: 'text-blue-500',
}

interface Props { customerId: string }

export default function CustomerLoyalty({ customerId }: Props) {
  const [balance, setBalance]           = useState<number>(0)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loading, setLoading]           = useState(true)
  const [enabled, setEnabled]           = useState(false)
  const [manualOpen, setManualOpen]     = useState(false)
  const [manualAmount, setManualAmount] = useState('')
  const [manualDesc, setManualDesc]     = useState('')

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: { balance: number; transactions: Transaction[]; settings: { is_enabled: boolean } } }>(
        '/api/v1/loyalty/customer/' + customerId
      )
      setBalance(res.data.balance)
      setTransactions(res.data.transactions)
      setEnabled(res.data.settings.is_enabled)
    } catch {
      toast.error('Помилка завантаження бонусів')
    } finally {
      setLoading(false)
    }
  }, [customerId])

  useEffect(() => { load() }, [load])

  if (loading) return <p className="text-gray-400 text-sm">Завантаження...</p>
  if (!enabled) return (
    <p className="text-gray-400 text-sm italic">Програма лояльності вимкнена</p>
  )

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
          <Star size={16} className="text-yellow-500" />
          Бонусний рахунок
        </h3>
        <div className="flex items-center gap-2">
          <button onClick={() => setManualOpen(!manualOpen)}
            className="text-xs text-blue-600 hover:text-blue-800 font-medium">+ Нарахувати</button>
          <span className="text-xl font-bold text-yellow-600">{formatMoney(balance)}</span>
        </div>
      </div>

      {manualOpen && (
        <div className="bg-gray-50 rounded-lg p-3 mb-3 space-y-2 border border-gray-200">
          <div className="flex gap-2">
            <input type="number" value={manualAmount}
              onChange={(e) => setManualAmount(e.target.value)}
              placeholder="Сума в грн"
              className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
            <input value={manualDesc}
              onChange={(e) => setManualDesc(e.target.value)}
              placeholder="Причина"
              className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
          </div>
          <div className="flex gap-2">
            <button onClick={async () => {
                const k = Math.round(parseFloat(manualAmount || '0') * 100)
                if (!k) return
                await api.post('/api/v1/customers/' + customerId + '/bonuses', { amount: k, description: manualDesc.trim() || null })
                setManualOpen(false); setManualAmount(''); setManualDesc(''); load()
              }}
              className="px-3 py-1 bg-blue-600 text-white text-xs rounded-lg hover:bg-blue-700">+ Нарахувати</button>
            <button onClick={async () => {
                const k = Math.round(parseFloat(manualAmount || '0') * 100)
                if (!k) return
                await api.post('/api/v1/customers/' + customerId + '/bonuses', { amount: -k, description: manualDesc.trim() || null })
                setManualOpen(false); setManualAmount(''); setManualDesc(''); load()
              }}
              className="px-3 py-1 bg-red-100 text-red-700 text-xs rounded-lg hover:bg-red-200">Списати</button>
          </div>
        </div>
      )}

      {transactions.length === 0 ? (
        <p className="text-gray-400 text-sm italic">Операцій ще немає</p>
      ) : (
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {transactions.slice(0, 20).map((t) => (
            <div key={t.id} className="flex items-center justify-between text-sm py-1 border-b border-gray-50 last:border-0">
              <div>
                <span className={TYPE_COLOR[t.type] + ' font-medium text-xs'}>
                  {TYPE_LABEL[t.type] ?? t.type}
                </span>
                {t.note && <span className="text-gray-400 text-xs ml-2">{t.note}</span>}
                <div className="text-xs text-gray-400">{formatDate(t.created_at)}</div>
              </div>
              <span className={(t.type === 'accrual' ? 'text-green-600' : 'text-red-500') + ' font-mono font-semibold text-xs'}>
                {t.type === 'accrual' ? '+' : '-'}{formatMoney(t.amount_kopecks)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
