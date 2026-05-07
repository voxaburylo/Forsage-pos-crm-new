import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Edit, Trash2, CreditCard, ShoppingBag } from 'lucide-react'
import { customerApi } from './customerApi'
import type { Customer, CustomerSale } from '@/types/customer'
import { Layout } from '@/components/Layout'
import { Button, Badge, Card, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney, formatDateTime } from '@/lib/utils'

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Готівка', card: 'Картка', debt: 'Борг', mixed: 'Змішана',
}

export default function CustomerDetailPage() {
  const navigate    = useNavigate()
  const { id }      = useParams<{ id: string }>()
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [sales, setSales]       = useState<CustomerSale[]>([])
  const [loading, setLoading]   = useState(true)
  const [payModal, setPayModal] = useState(false)
  const [payAmount, setPayAmount] = useState('')
  const [paying, setPaying]     = useState(false)

  async function load() {
    if (!id) return
    try {
      const [{ data }, { data: s }] = await Promise.all([
        customerApi.get(id),
        customerApi.getSales(id),
      ])
      setCustomer(data)
      setSales(s)
    } catch {
      navigate('/customers')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])  // eslint-disable-line react-hooks/exhaustive-deps

  async function handleDelete() {
    if (!customer || !confirm(`Видалити клієнта "${customer.full_name ?? customer.phone}"?`)) return
    try {
      await customerApi.delete(customer.id)
      toast.success('Клієнта видалено')
      navigate('/customers')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
    }
  }

  async function handlePayDebt() {
    if (!customer || !payAmount) return
    const kopecks = Math.round(parseFloat(payAmount) * 100)
    if (kopecks <= 0) { toast.error('Вкажіть суму більше 0'); return }

    setPaying(true)
    try {
      const { data } = await customerApi.payDebt(customer.id, kopecks)
      setCustomer(data)
      setPayModal(false)
      setPayAmount('')
      toast.success(`Борг погашено на ${formatMoney(kopecks)}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
    } finally {
      setPaying(false)
    }
  }

  if (loading || !customer) return (
    <Layout><div className="flex items-center justify-center h-64 text-gray-400 text-sm">Завантаження...</div></Layout>
  )

  return (
    <Layout
      title={customer.full_name ?? customer.phone}
      actions={
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" icon={<Edit size={14} />} onClick={() => navigate(`/customers/${customer.id}/edit`)}>
            Редагувати
          </Button>
          <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={handleDelete}>
            Видалити
          </Button>
        </div>
      }
    >
      <div className="max-w-3xl space-y-4">

        {/* Основна інфо */}
        <Card>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Телефон</p>
              <p className="font-mono font-semibold text-gray-900">{customer.phone}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Email</p>
              <p className="text-sm text-gray-800">{customer.email ?? '—'}</p>
            </div>
          </div>
          {customer.tags.length > 0 && (
            <div className="flex gap-2 mt-3">
              {customer.tags.map((t) => <Badge key={t} color="blue">{t}</Badge>)}
            </div>
          )}
          {customer.notes && (
            <div className="mt-3 pt-3 border-t border-gray-100">
              <p className="text-xs text-gray-400 mb-0.5">Примітки</p>
              <p className="text-sm text-gray-700">{customer.notes}</p>
            </div>
          )}
        </Card>

        {/* Борг */}
        <Card className={customer.debt_balance > 0 ? 'border-red-200 bg-red-50' : ''}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Поточний борг</p>
              <p className={`text-2xl font-bold ${customer.debt_balance > 0 ? 'text-red-600' : 'text-green-600'}`}>
                {customer.debt_balance > 0 ? formatMoney(customer.debt_balance) : 'Без боргу'}
              </p>
            </div>
            {customer.debt_balance > 0 && (
              <Button icon={<CreditCard size={16} />} onClick={() => setPayModal(true)}>
                Погасити борг
              </Button>
            )}
          </div>
        </Card>

        {/* Історія покупок */}
        <Card padding="none">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
            <ShoppingBag size={16} className="text-gray-400" />
            <h3 className="font-semibold text-gray-800 text-sm">Історія покупок ({sales.length})</h3>
          </div>
          {sales.length === 0 ? (
            <p className="px-6 py-8 text-center text-gray-400 text-sm">Покупок ще немає</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {sales.map((s) => (
                <div key={s.id} className="px-6 py-3 flex items-center justify-between text-sm">
                  <div>
                    <span className="font-mono text-gray-600 text-xs">#{s.sale_number}</span>
                    <span className="mx-2 text-gray-300">·</span>
                    <span className="text-gray-500">{PAYMENT_LABELS[s.payment_method] ?? s.payment_method}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="font-semibold text-gray-900">{formatMoney(s.total)}</span>
                    <span className="text-gray-400 text-xs">{formatDateTime(s.completed_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Модалка погашення боргу */}
      <Modal open={payModal} onClose={() => setPayModal(false)} title="Погасити борг" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Поточний борг: <strong className="text-red-600">{formatMoney(customer.debt_balance)}</strong>
          </p>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Сума оплати (грн)</label>
            <input
              type="number"
              min="0.01"
              step="0.01"
              max={(customer.debt_balance / 100).toFixed(2)}
              value={payAmount}
              onChange={(e) => setPayAmount(e.target.value)}
              placeholder="0.00"
              autoFocus
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div className="flex gap-3">
            <Button loading={paying} onClick={handlePayDebt} className="flex-1">
              Підтвердити оплату
            </Button>
            <Button variant="secondary" onClick={() => setPayModal(false)}>Скасувати</Button>
          </div>
        </div>
      </Modal>
    </Layout>
  )
}
