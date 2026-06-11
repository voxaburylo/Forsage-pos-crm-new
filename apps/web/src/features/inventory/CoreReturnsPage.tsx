import { useEffect, useState } from 'react'
import { Layout } from '@/components/Layout'
import { Card, Button, Badge } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatDate } from '@/lib/utils'
import { api } from '@/lib/api'
import { RefreshCw, ArrowLeftRight, User, Truck, DollarSign, Wallet } from 'lucide-react'

export interface ClientCoreReturn {
  id: string
  type: 'sale' | 'order'
  created_at: string
  core_deposit_amount: number
  core_return_status: 'pending' | 'returned' | 'refunded'
  product: { id: string; name: string; sku: string; brand: { name: string } | null } | null
  customer: { id: string; full_name: string; phone: string } | null
  doc_number: string
  doc_date: string
}

export interface SupplierCoreDebt {
  id: string
  product: { id: string; name: string; sku: string; requires_core_return: boolean; core_deposit_amount: number; brand: { name: string } | null } | null
  supplier: { id: string; name: string } | null
  invoice_number: string | null
  posted_at: string | null
  qty: number
  core_returned_qty: number
  status: 'new' | 'partial' | 'paid'
  core_deposit_amount: number
}

export default function CoreReturnsPage() {
  const [activeTab, setActiveTab] = useState<'client' | 'supplier'>('client')
  const [clientReturns, setClientReturns] = useState<ClientCoreReturn[]>([])
  const [supplierDebts, setSupplierDebts] = useState<SupplierCoreDebt[]>([])
  const [loading, setLoading] = useState(false)
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null)
  const [returnQty, setReturnQty] = useState<Record<string, string>>({})

  async function loadData() {
    setLoading(true)
    try {
      const res = await api.get<{ clientReturns: ClientCoreReturn[]; supplierDebts: SupplierCoreDebt[] }>('/api/v1/core-returns')
      setClientReturns(res.clientReturns ?? [])
      setSupplierDebts(res.supplierDebts ?? [])
    } catch {
      toast.error('Помилка завантаження даних повернень')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  async function handleStatusChange(
    type: 'sale' | 'order',
    itemId: string,
    newStatus: 'pending' | 'returned' | 'refunded',
    refundMethod?: 'cash' | 'balance' | null
  ) {
    setActionLoadingId(itemId)
    try {
      await api.post(`/api/v1/core-returns/${type}/${itemId}/status`, {
        status: newStatus,
        refund_method: refundMethod
      })
      toast.success(
        newStatus === 'returned'
          ? 'Деталь прийнято від клієнта!'
          : refundMethod === 'balance'
          ? 'Заставу зараховано на баланс клієнта!'
          : 'Заставу повернуто готівкою!'
      )
      loadData()
    } catch (err: any) {
      toast.error(err?.message || 'Помилка зміни статусу')
    } finally {
      setActionLoadingId(null)
    }
  }

  async function handleSupplierReturn(item: SupplierCoreDebt) {
    const remaining = item.qty - item.core_returned_qty
    const qty = parseFloat(returnQty[item.id] || '') || remaining
    if (qty <= 0) { toast.error('Кількість має бути більшою за нуль'); return }
    setActionLoadingId(item.id)
    try {
      await api.post(`/api/v1/core-returns/supplier/${item.id}/return`, { qty })
      toast.success('Повернення зараховано!')
      setReturnQty((prev) => ({ ...prev, [item.id]: '' }))
      loadData()
    } catch (err: any) {
      toast.error(err?.message || 'Помилка зарахування повернення')
    } finally {
      setActionLoadingId(null)
    }
  }

  return (
    <Layout title="Повернення серцевин (Core Exchange)">
      <div className="mb-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <p className="text-gray-500 text-sm">
            Керування обміном та заставною вартістю деталей (стартери, супорти, генератори)
          </p>
        </div>
        <Button onClick={loadData} disabled={loading} className="flex items-center gap-2">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Оновити
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 mb-6">
        <button
          onClick={() => setActiveTab('client')}
          className={`flex items-center gap-2 py-3 px-6 text-sm font-semibold border-b-2 transition-all ${
            activeTab === 'client'
              ? 'border-yellow-400 text-gray-900 bg-yellow-50/20'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
          }`}
        >
          <User size={16} /> Повернення від клієнтів ({clientReturns.length})
        </button>
        <button
          onClick={() => setActiveTab('supplier')}
          className={`flex items-center gap-2 py-3 px-6 text-sm font-semibold border-b-2 transition-all ${
            activeTab === 'supplier'
              ? 'border-yellow-400 text-gray-900 bg-yellow-50/20'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
          }`}
        >
          <Truck size={16} /> Борг перед постачальниками ({supplierDebts.length})
        </button>
      </div>

      {activeTab === 'client' ? (
        <Card className="p-0 overflow-hidden">
          {clientReturns.length === 0 ? (
            <div className="text-center py-12 text-gray-400 text-sm">
              Немає активних застав або очікуваних повернень від клієнтів
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-gray-50 text-gray-400 text-xs font-bold uppercase tracking-wider border-b border-gray-100">
                    <th className="px-6 py-3">Клієнт</th>
                    <th className="px-6 py-3">Запчастина</th>
                    <th className="px-6 py-3">Документ</th>
                    <th className="px-6 py-3 text-right">Сума застави</th>
                    <th className="px-6 py-3 text-center">Статус</th>
                    <th className="px-6 py-3 text-center">Дії</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {clientReturns.map((item) => (
                    <tr key={item.id} className="hover:bg-gray-50/20">
                      <td className="px-6 py-4">
                        <div className="font-semibold text-gray-900">{item.customer?.full_name || 'Гість'}</div>
                        <div className="text-xs text-gray-400 font-mono">{item.customer?.phone || '-'}</div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="font-semibold text-gray-900">{item.product?.name || 'Запчастина'}</div>
                        <div className="text-xs text-gray-500 flex gap-2 flex-wrap items-center">
                          {item.product?.sku && <span className="font-mono">Артикул: {item.product.sku}</span>}
                          {item.product?.brand?.name && (
                            <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[10px]">
                              {item.product.brand.name}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-gray-700">Придбано з {item.doc_number}</div>
                        <div className="text-xs text-gray-400">{formatDate(item.doc_date)}</div>
                      </td>
                      <td className="px-6 py-4 text-right font-bold text-gray-900">
                        {(item.core_deposit_amount / 100).toLocaleString()} грн
                      </td>
                      <td className="px-6 py-4 text-center">
                        <Badge
                          color={item.core_return_status === 'returned' ? 'blue' : 'yellow'}
                          className="font-bold text-xs"
                        >
                          {item.core_return_status === 'returned' ? 'Прийнято (очікує виплати)' : 'Борг (очікує деталь)'}
                        </Badge>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex justify-center gap-2">
                          {item.core_return_status === 'pending' && (
                            <Button
                              onClick={() => handleStatusChange(item.type, item.id, 'returned')}
                              disabled={actionLoadingId === item.id}
                              size="sm"
                              className="bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-1.5"
                            >
                              <ArrowLeftRight size={13} /> Прийняти деталь
                            </Button>
                          )}
                          {item.core_return_status === 'returned' && (
                            <>
                              <Button
                                onClick={() => handleStatusChange(item.type, item.id, 'refunded', 'cash')}
                                disabled={actionLoadingId === item.id}
                                size="sm"
                                variant="outline"
                                className="border-green-600 text-green-700 hover:bg-green-50 flex items-center gap-1.5"
                              >
                                <DollarSign size={13} /> Виплатити готівкою
                              </Button>
                              <Button
                                onClick={() => handleStatusChange(item.type, item.id, 'refunded', 'balance')}
                                disabled={actionLoadingId === item.id}
                                size="sm"
                                className="bg-green-600 hover:bg-green-700 text-white flex items-center gap-1.5"
                              >
                                <Wallet size={13} /> На баланс клієнта
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : (
        <Card className="p-0 overflow-hidden">
          {supplierDebts.length === 0 ? (
            <div className="text-center py-12 text-gray-400 text-sm">
              Немає боргів перед постачальниками за повернення серцевин
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-gray-50 text-gray-400 text-xs font-bold uppercase tracking-wider border-b border-gray-100">
                    <th className="px-6 py-3">Постачальник</th>
                    <th className="px-6 py-3">Запчастина</th>
                    <th className="px-6 py-3">Накладна</th>
                    <th className="px-6 py-3 text-right">Кількість</th>
                    <th className="px-6 py-3 text-right">Сума застави</th>
                    <th className="px-6 py-3 text-center">Статус боргу</th>
                    <th className="px-6 py-3 text-center">Дії</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {supplierDebts.map((item) => (
                    <tr key={item.id} className="hover:bg-gray-50/20">
                      <td className="px-6 py-4 font-semibold text-gray-900">
                        {item.supplier?.name || 'Постачальник'}
                      </td>
                      <td className="px-6 py-4">
                        <div className="font-semibold text-gray-900">{item.product?.name || 'Запчастина'}</div>
                        <div className="text-xs text-gray-500 flex gap-2 flex-wrap items-center">
                          {item.product?.sku && <span className="font-mono">Артикул: {item.product.sku}</span>}
                          {item.product?.brand?.name && (
                            <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[10px]">
                              {item.product.brand.name}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-gray-700">Накладна #{item.invoice_number || '-'}</div>
                        <div className="text-xs text-gray-400">
                          {item.posted_at ? formatDate(item.posted_at) : '-'}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right font-semibold text-gray-800">
                        {item.qty} шт
                        {item.core_returned_qty > 0 && (
                          <div className="text-xs text-gray-400 font-normal">повернуто {item.core_returned_qty}</div>
                        )}
                      </td>
                      <td className="px-6 py-4 text-right font-bold text-gray-900">
                        {((item.core_deposit_amount * (item.qty - item.core_returned_qty)) / 100).toLocaleString()} грн
                      </td>
                      <td className="px-6 py-4 text-center">
                        {item.status === 'paid' ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-semibold bg-green-100 text-green-800">
                            ✓ Оплачений
                          </span>
                        ) : item.status === 'partial' ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-800">
                            ◐ Частково оплачений
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-semibold bg-red-100 text-red-800">
                            📍 Новий
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        {item.status !== 'paid' && (
                          <div className="flex items-center justify-center gap-2">
                            <input
                              type="number" min="0.001" step="any"
                              value={returnQty[item.id] ?? ''}
                              onChange={(e) => setReturnQty((prev) => ({ ...prev, [item.id]: e.target.value }))}
                              placeholder={String(item.qty - item.core_returned_qty)}
                              className="w-20 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-yellow-400"
                            />
                            <Button
                              onClick={() => handleSupplierReturn(item)}
                              disabled={actionLoadingId === item.id}
                              size="sm"
                              className="bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-1.5 whitespace-nowrap"
                            >
                              <ArrowLeftRight size={13} /> Зарахувати
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </Layout>
  )
}
