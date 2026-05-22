import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Edit3, FileText, Plus } from 'lucide-react'
import { supplierApi } from './supplierApi'
import type { Supplier, SupplyInvoice, PaginatedInvoices } from '@/types/supplier'
import { Layout } from '@/components/Layout'
import { Button, Badge, Card, Table } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney, formatDate } from '@/lib/utils'

const STATUS_BADGE: Record<string, 'yellow' | 'green' | 'red'> = {
  draft: 'yellow', posted: 'green', cancelled: 'red',
}
const STATUS_LABEL: Record<string, string> = {
  draft: 'Чернетка', posted: 'Проведено', cancelled: 'Скасовано',
}

export default function SupplierDetailPage() {
  const navigate = useNavigate()
  const { id } = useParams()
  const [supplier, setSupplier]   = useState<Supplier | null>(null)
  const [invoices, setInvoices]   = useState<PaginatedInvoices | null>(null)
  const [loading, setLoading]     = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const [supRes, invRes] = await Promise.all([
          supplierApi.get(id!),
          supplierApi.listInvoices({ supplier_id: id, per_page: 50 }),
        ])
        setSupplier(supRes.data)
        setInvoices(invRes)
      } catch {
        toast.error('Не вдалось завантажити постачальника')
        navigate('/suppliers')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id])

  if (loading || !supplier) {
    return <Layout title="Завантаження..."><div className="text-gray-400 text-sm">Завантаження...</div></Layout>
  }

  const invoiceColumns = [
    { key: 'num', header: '№', render: (inv: SupplyInvoice) => (
      <button onClick={() => navigate(`/suppliers/invoices/${inv.id}`)} className="text-left hover:text-yellow-600 font-mono text-sm">
        {inv.invoice_number ?? '—'}
      </button>
    )},
    { key: 'status', header: 'Статус', render: (inv: SupplyInvoice) => (
      <Badge color={STATUS_BADGE[inv.status] ?? 'gray'}>{STATUS_LABEL[inv.status] ?? inv.status}</Badge>
    )},
    { key: 'total', header: 'Сума', className: 'text-right', render: (inv: SupplyInvoice) => formatMoney(inv.total) },
    { key: 'date', header: 'Дата', className: 'hidden md:table-cell text-sm text-gray-500', render: (inv: SupplyInvoice) => formatDate(inv.created_at) },
  ]

  return (
    <Layout
      title={supplier.name}
      onBack={() => navigate('/suppliers')}
      actions={
        <div className="flex gap-2">
          <Button variant="outline" icon={<FileText size={16} />} onClick={() => navigate(`/suppliers/invoices/new?supplier_id=${supplier.id}`)}>
            Накладна
          </Button>
          <Button icon={<Edit3 size={16} />} onClick={() => navigate(`/suppliers/${supplier.id}/edit`)}>
            Редагувати
          </Button>
        </div>
      }
    >
      {/* Інформація */}
      <Card className="mb-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-gray-500 text-xs mb-1">Телефон</p>
            <p className="font-medium">{supplier.phone ?? '—'}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-1">Email</p>
            <p className="font-medium">{supplier.email ?? '—'}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-1">Контакт</p>
            <p className="font-medium">{supplier.contact_name ?? '—'}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-1">Статус</p>
            <Badge color={supplier.is_active ? 'green' : 'red'}>{supplier.is_active ? 'Активний' : 'Неактивний'}</Badge>
          </div>
        </div>
        {supplier.notes && (
          <p className="text-sm text-gray-600 mt-4 pt-4 border-t border-gray-100">{supplier.notes}</p>
        )}
      </Card>

      {/* Приходні накладні */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-800">Приходні накладні</h3>
        <Button size="sm" icon={<Plus size={14} />} onClick={() => navigate(`/suppliers/invoices/new?supplier_id=${supplier.id}`)}>
          Додати
        </Button>
      </div>
      <Card padding="none">
        <Table
          columns={invoiceColumns}
          data={invoices?.data ?? []}
          keyFn={(inv) => inv.id}
          empty={<p className="text-center text-gray-400 text-sm py-4">Накладних поки немає</p>}
        />
      </Card>
    </Layout>
  )
}