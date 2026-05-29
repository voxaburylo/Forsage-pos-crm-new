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

  const userRole = useAuthStore((s) => s.session?.user?.user_metadata?.role as string | undefined)
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
                <td className="px-2 py-2 text-right">{item.qty} {item.product?.unit ?? ''}</td>
                <td className="px-2 py-2 text-right font-mono">{formatMoney(item.purchase_price)}</td>
                <td className="px-4 py-2 text-right font-mono">{formatMoney(item.total)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold bg-gray-50">
              <td colSpan={3} className="px-4 py-2 text-right">Всього:</td>
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
    </>
  )
}