import { useState, useEffect } from 'react'
import { Clock, Bell, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Layout } from '@/components/Layout'
import { Card, Badge, ConfirmDialog } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney, formatDate } from '@/lib/utils'

interface WaitlistEntry {
  id: string
  product_id: string
  customer_id: string
  status: 'waiting' | 'notified' | 'fulfilled'
  created_at: string
  notified_at: string | null
  product: { id: string; sku: string; name: string; retail_price: number; qty_on_hand: number }
  customer: { id: string; phone: string; full_name: string | null }
}

export default function WaitlistPage() {
  const [entries, setEntries] = useState<WaitlistEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId]   = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const res = await api.get<{ data: WaitlistEntry[] }>('/api/v1/waitlist')
      setEntries(res.data)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не вдалося завантажити')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleNotify(id: string) {
    setBusyId(id)
    try {
      await api.post(`/api/v1/waitlist/${id}/notify`, {})
      toast.success('Клієнта сповіщено')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка сповіщення')
    } finally {
      setBusyId(null)
    }
  }

  const [confirmDelId, setConfirmDelId] = useState<string | null>(null)

  async function doDelete() {
    if (!confirmDelId) return
    setBusyId(confirmDelId)
    try {
      await api.delete(`/api/v1/waitlist/${confirmDelId}`)
      toast.success('Видалено')
      setEntries((prev) => prev.filter((e) => e.id !== confirmDelId))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Layout title="Лист очікування">
      <div className="max-w-4xl">
        <div className="flex items-center gap-2 mb-4">
          <Clock size={16} className="text-gray-400" />
          <span className="text-sm text-gray-500">Активні очікування: {entries.filter((e) => e.status === 'waiting').length}</span>
        </div>

        <Card padding="none">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr className="text-xs text-gray-500 uppercase">
                <th className="text-left px-4 py-3">Клієнт</th>
                <th className="text-left px-4 py-3">Товар</th>
                <th className="text-right px-4 py-3">Ціна</th>
                <th className="text-right px-4 py-3">Залишок</th>
                <th className="text-center px-4 py-3">Статус</th>
                <th className="text-right px-4 py-3">Дата</th>
                <th className="text-right px-4 py-3 w-24">Дії</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {loading ? (
                <tr><td colSpan={7} className="text-center text-gray-400 py-8">Завантаження...</td></tr>
              ) : entries.length === 0 ? (
                <tr><td colSpan={7} className="text-center text-gray-400 py-8">Немає очікувань</td></tr>
              ) : entries.map((e) => (
                <tr key={e.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{e.customer.full_name ?? e.customer.phone}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-800">{e.product.name}</div>
                    <div className="text-xs text-gray-400 font-mono">{e.product.sku}</div>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold">{formatMoney(e.product.retail_price)}</td>
                  <td className="px-4 py-3 text-right">
                    {e.product.qty_on_hand > 0
                      ? <span className="text-green-600 font-medium">{e.product.qty_on_hand}</span>
                      : <span className="text-red-400">Нема</span>
                    }
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Badge color={e.status === 'waiting' ? 'orange' : e.status === 'notified' ? 'green' : 'gray'}>
                      {e.status === 'waiting' ? 'Очікує' : e.status === 'notified' ? 'Сповіщено' : 'Виконано'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-400 text-xs">{formatDate(e.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {e.status === 'waiting' && (
                        <button
                          onClick={() => handleNotify(e.id)}
                          disabled={busyId === e.id}
                          className="text-blue-500 hover:text-blue-700 p-1 rounded disabled:opacity-40"
                          title="Сповістити вручну"
                        >
                          <Bell size={14} />
                        </button>
                      )}
                      <button
                        onClick={() => setConfirmDelId(e.id)}
                        disabled={busyId === e.id}
                        className="text-gray-400 hover:text-red-600 p-1 rounded disabled:opacity-40"
                        title="Видалити"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <ConfirmDialog
        open={confirmDelId !== null}
        onClose={() => setConfirmDelId(null)}
        onConfirm={doDelete}
        title="Видалити запис"
        message="Видалити запис з листа очікування?"
        confirmLabel="Видалити"
        danger
      />
    </Layout>
  )
}
