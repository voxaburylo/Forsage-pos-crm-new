import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { writeoffApi } from './writeoffApi'
import { REASON_LABEL, REASON_COLOR } from '@/types/writeoff'
import type { Writeoff } from '@/types/writeoff'
import { Layout } from '@/components/Layout'
import { Badge, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatDate, formatMoney } from '@/lib/utils'

export default function WriteoffDetailPage() {
  const navigate = useNavigate()
  const { id } = useParams()
  const [writeoff, setWriteoff] = useState<Writeoff | null>(null)
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    writeoffApi.get(id!).then((res) => setWriteoff(res.data)).catch(() => {
      toast.error('Акт не знайдено')
      navigate('/inventory/writeoffs')
    }).finally(() => setLoading(false))
  }, [id])

  if (loading || !writeoff) {
    return <Layout title="Завантаження..."><div className="text-gray-400 text-sm">Завантаження...</div></Layout>
  }

  const totalCost = (writeoff.items ?? []).reduce((s, i) => s + i.cost_kopecks, 0)

  return (
    <Layout
      title={'Акт списання — ' + formatDate(writeoff.created_at)}
      onBack={() => navigate('/inventory/writeoffs')}
    >
      <Card className="mb-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-gray-500 text-xs mb-1">Причина</p>
            <Badge color={REASON_COLOR[writeoff.reason]}>{REASON_LABEL[writeoff.reason]}</Badge>
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-1">Дата</p>
            <p className="font-medium">{formatDate(writeoff.created_at)}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-1">Позицій</p>
            <p className="font-medium">{writeoff.items?.length ?? 0}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-1">Собівартість</p>
            <p className="font-mono font-bold">{formatMoney(totalCost)}</p>
          </div>
        </div>
        {writeoff.notes && (
          <p className="text-sm text-gray-600 mt-4 pt-4 border-t border-gray-100">{writeoff.notes}</p>
        )}
      </Card>

      <Card padding="none">
        <div className="px-4 py-3 border-b border-gray-100">
          <span className="text-sm font-semibold text-gray-800">
            Позиції ({writeoff.items?.length ?? 0})
          </span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-500 uppercase border-b border-gray-100">
              <th className="text-left px-4 py-2">Товар</th>
              <th className="text-right px-2 py-2 w-28">Кількість</th>
              <th className="text-right px-4 py-2 w-32">Собівартість</th>
            </tr>
          </thead>
          <tbody>
            {(writeoff.items ?? []).map((item) => (
              <tr key={item.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                <td className="px-4 py-2">
                  <div className="font-medium">{item.product?.name ?? '—'}</div>
                  {item.product?.sku && (
                    <div className="text-xs text-gray-400">{item.product.sku}</div>
                  )}
                </td>
                <td className="px-2 py-2 text-right">
                  {item.qty} {item.product?.unit ?? ''}
                </td>
                <td className="px-4 py-2 text-right font-mono">{formatMoney(item.cost_kopecks)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold bg-gray-50">
              <td colSpan={2} className="px-4 py-2 text-right">Всього:</td>
              <td className="px-4 py-2 text-right font-mono">{formatMoney(totalCost)}</td>
            </tr>
          </tfoot>
        </table>
      </Card>
    </Layout>
  )
}
