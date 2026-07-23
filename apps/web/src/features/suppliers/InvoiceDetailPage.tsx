import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Tag, Trash2 } from 'lucide-react'
import { supplierApi } from './supplierApi'
import type { SupplyInvoice } from '@/types/supplier'
import { Layout } from '@/components/Layout'
import { Button, Badge, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney, formatDate } from '@/lib/utils'
import { LabelPrintModal } from './LabelPrintModal'
import { useAuthStore } from '@/stores/authStore'
import { Modal, Input } from '@/components/ui'
import { shiftApi } from '@/features/pos/shiftApi'

const STATUS_BADGE: Record<string, 'yellow' | 'green' | 'red'> = {
  draft: 'yellow', posted: 'green', cancelled: 'red',
}
const STATUS_LABEL: Record<string, string> = {
  draft: 'Чернетка', posted: 'Проведено', cancelled: 'Скасовано',
}

export default function InvoiceDetailPage() {
  const navigate = useNavigate()
  const { id } = useParams()
  const [invoice, setInvoice] = useState<SupplyInvoice | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [labelModal, setLabelModal]       = useState(false)
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'transfer'>('cash')
  const [fundSource, setFundSource] = useState<'cashbox' | 'owner_funds' | 'bank_account' | 'business_card'>('cashbox')
  const [paymentNote, setPaymentNote] = useState('')

  const userRole = useAuthStore((s) => s.session?.user?.app_metadata?.role as string | undefined)
  const canDelete = userRole === 'owner' || userRole === 'admin'

  async function handleDelete() {
    if (!confirm('Ви впевнені, що хочете остаточно видалити цю накладну? Цю дію неможливо скасувати.')) return
    setActionLoading(true)
    try {
      await supplierApi.deleteInvoice(id!)
      toast.success('Накладну видалено')
      navigate('/suppliers/invoices')
    } catch {
      toast.error('Помилка видалення накладної')
    } finally {
      setActionLoading(false)
    }
  }

  function load() {
    supplierApi.getInvoice(id!).then((res) => setInvoice(res.data)).catch(() => {
      toast.error('Не вдалось завантажити накладну')
      navigate('/suppliers/invoices')
    }).finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [id])

  async function handlePost() {
    if (!confirm('Провести накладну? Це збільшить залишки товарів на складі.')) return
    setActionLoading(true)
    try {
      await supplierApi.postInvoice(id!)
      toast.success('Накладну проведено')
      load()
    } catch {
      toast.error('Помилка проведення')
    } finally {
      setActionLoading(false)
    }
  }

  async function handleCancel() {
    if (!confirm('Скасувати накладну? Товари будуть списані зі складу.')) return
    setActionLoading(true)
    try {
      await supplierApi.cancelInvoice(id!)
      toast.success('Накладну скасовано')
      load()
    } catch {
      toast.error('Помилка скасування')
    } finally {
      setActionLoading(false)
    }
  }

  async function handleSupplierPayment() {
    if (!invoice) return
    const amount = Math.round(Number(paymentAmount) * 100)
    const debt = Math.max(0, invoice.total - (invoice.paid_amount ?? 0))
    if (!amount || amount <= 0 || amount > debt) {
      toast.error('Перевірте суму оплати')
      return
    }
    setActionLoading(true)
    try {
      const currentShift = fundSource === 'cashbox'
        ? await shiftApi.current().catch(() => null)
        : null
      const shiftId = (currentShift as any)?.data?.id ?? null
      if (fundSource === 'cashbox' && !shiftId) {
        toast.error('Щоб платити з каси, спочатку відкрийте касову зміну')
        return
      }
      await supplierApi.payInvoice(id!, {
        amount,
        payment_method: paymentMethod,
        fund_source: fundSource,
        shift_id: shiftId,
        note: paymentNote.trim() || null,
      })
      toast.success('Оплату постачальнику записано')
      setPaymentOpen(false)
      setPaymentNote('')
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка оплати')
    } finally {
      setActionLoading(false)
    }
  }


  if (loading || !invoice) {
    return <Layout title="Завантаження..."><div className="text-gray-400 text-sm">Завантаження...</div></Layout>
  }

  return (
    <>
    <Layout
      title={`Накладна ${invoice.invoice_number ?? '—'}`}
      onBack={() => navigate('/suppliers/invoices')}
      actions={
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate(`/suppliers/invoices/new?clone=${id}`)}>
            Дублювати
          </Button>
          {invoice.status === 'draft' && (
            <>
              {canDelete && (
                <Button variant="danger-outline" icon={<Trash2 size={15} />} onClick={handleDelete} disabled={actionLoading}>
                  {actionLoading ? '...' : 'Видалити'}
                </Button>
              )}
              <Button variant="outline" onClick={() => navigate(`/suppliers/invoices/${id}/edit`)}>
                Редагувати
              </Button>
              <Button onClick={handlePost} disabled={actionLoading}>
                {actionLoading ? '...' : 'Провести'}
              </Button>
            </>
          )}
          {invoice.status === 'posted' && (
            <>
              <Button variant="secondary" icon={<Tag size={15} />} onClick={() => setLabelModal(true)}>
                Друк етикеток
              </Button>
              <Button variant="danger-outline" onClick={handleCancel} disabled={actionLoading}>
                {actionLoading ? '...' : 'Скасувати'}
              </Button>
            </>
          )}
          {invoice.status === 'cancelled' && canDelete && (
            <Button variant="danger" icon={<Trash2 size={15} />} onClick={handleDelete} disabled={actionLoading}>
              {actionLoading ? '...' : 'Видалити'}
            </Button>
          )}
        </div>
      }
    >
      {/* Інформація */}
      <Card className="mb-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-gray-500 text-xs mb-1">Постачальник</p>
            <p className="font-medium">{invoice.supplier?.name ?? '—'}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-1">Статус</p>
            <Badge color={STATUS_BADGE[invoice.status] ?? 'gray'}>{STATUS_LABEL[invoice.status] ?? invoice.status}</Badge>
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-1">Сума</p>
            <p className="font-mono font-bold text-lg">{formatMoney(invoice.total)}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-1">Дата</p>
            <p className="font-medium">{formatDate(invoice.created_at)}</p>
          </div>
        </div>
        {invoice.notes && (
          <p className="text-sm text-gray-600 mt-4 pt-4 border-t border-gray-100">{invoice.notes}</p>
        )}
        {/* Оплата постачальнику */}
        {(() => {
          const paid = invoice.paid_amount ?? 0
          const debt = Math.max(0, invoice.total - paid)
          return (
            <div className="mt-4 pt-4 border-t border-gray-100 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <span className="text-gray-600">Оплачено: <strong className="text-green-600">{formatMoney(paid)}</strong></span>
              {debt > 0 ? (
                <>
                  <span className="text-gray-600">Борг постачальнику: <strong className="text-red-600">{formatMoney(debt)}</strong></span>
                  <Button size="sm" variant="outline" disabled={actionLoading}
                    onClick={() => {
                      setPaymentAmount((debt / 100).toFixed(2))
                      setPaymentOpen(true)
                    }}>
                    💵 Доплатити
                  </Button>
                </>
              ) : (
                <span className="text-green-600 font-semibold">✓ Оплачено повністю</span>
              )}
            </div>
          )
        })()}
      </Card>

      {/* Позиції */}
      <Card padding="none">
        <div className="px-4 py-3 border-b border-gray-100">
          <span className="text-sm font-semibold text-gray-800">Позиції ({invoice.items?.length ?? 0})</span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-500 uppercase border-b border-gray-100">
              <th className="text-left px-4 py-2">Товар</th>
              <th className="text-left px-2 py-2 w-32">Комірка</th>
              <th className="text-right px-2 py-2 w-20">Кількість</th>
              <th className="text-right px-2 py-2 w-28">Ціна закупівлі</th>
              <th className="text-right px-4 py-2 w-28">Сума</th>
            </tr>
          </thead>
          <tbody>
            {(invoice.items ?? []).map((item) => (
              <tr key={item.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                <td className="px-4 py-2 font-medium">
                  {item.product?.name ?? '—'}
                  {item.product?.sku && <span className="text-gray-400 text-xs ml-2">({item.product.sku})</span>}
                </td>
                <td className="px-2 py-2 font-mono">
                  {item.product?.storage_bin ? (
                    <span className="px-1.5 py-0.5 rounded bg-yellow-50 border border-yellow-200/50 text-yellow-800 text-xs font-bold font-mono">
                      📍 {item.product.storage_bin}
                    </span>
                  ) : (
                    <span className="text-gray-400 text-xs italic">немає</span>
                  )}
                </td>
                <td className="px-2 py-2 text-right">{item.qty} {item.product?.unit ?? ''}</td>
                <td className="px-2 py-2 text-right font-mono">{formatMoney(item.purchase_price)}</td>
                <td className="px-4 py-2 text-right font-mono">{formatMoney(item.total)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold bg-gray-50">
              <td colSpan={4} className="px-4 py-2 text-right">Всього:</td>
              <td className="px-4 py-2 text-right font-mono">{formatMoney(invoice.total)}</td>
            </tr>
          </tfoot>
        </table>
      </Card>
    </Layout>

    {labelModal && invoice && (
      <LabelPrintModal
        open={labelModal}
        onClose={() => setLabelModal(false)}
        invoice={invoice}
      />
    )}
    <Modal open={paymentOpen} onClose={() => setPaymentOpen(false)} title="Оплата постачальнику" size="sm">
      <div className="space-y-4">
        <Input label="Сума, грн" type="number" min="0.01" step="0.01"
          value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} />
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Спосіб оплати</label>
          <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as typeof paymentMethod)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm">
            <option value="cash">Готівка</option>
            <option value="card">Картка / термінал</option>
            <option value="transfer">Банківський переказ</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Звідки взяті гроші</label>
          <select value={fundSource} onChange={(e) => setFundSource(e.target.value as typeof fundSource)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm">
            <option value="cashbox">З каси магазину</option>
            <option value="owner_funds">Власні кошти власника</option>
            <option value="bank_account">Розрахунковий рахунок</option>
            <option value="business_card">Картка підприємства</option>
          </select>
          {fundSource === 'cashbox' && (
            <p className="mt-1 text-xs text-gray-500">Сума буде записана як виймання з поточної касової зміни.</p>
          )}
        </div>
        <Input label="Примітка (необов’язково)" value={paymentNote}
          onChange={(e) => setPaymentNote(e.target.value)} placeholder="Номер платежу або пояснення" />
        <div className="flex gap-3 pt-1">
          <Button variant="secondary" onClick={() => setPaymentOpen(false)} className="flex-1">Скасувати</Button>
          <Button onClick={handleSupplierPayment} loading={actionLoading} className="flex-1">Записати оплату</Button>
        </div>
      </div>
    </Modal>
    </>
  )
}
