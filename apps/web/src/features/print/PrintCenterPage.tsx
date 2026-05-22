import { useState, useEffect, useCallback } from 'react'
import { Printer, RefreshCw } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Button } from '@/components/ui'
import { api } from '@/lib/api'

interface PrintJob {
  id: string
  document_type: string
  document_id: string | null
  title: string
  copies: number
  status: string
  printed_at: string | null
  created_at: string
}

const DOC_TYPE_LABELS: Record<string, string> = {
  receipt: 'Чек',
  label: 'Етикетка',
  order: 'Замовлення',
  picking_list: 'Список збірки',
  other: 'Інше',
}

function fmt(d: string) {
  return new Date(d).toLocaleString('uk-UA', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

export default function PrintCenterPage() {
  const [jobs, setJobs] = useState<PrintJob[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const url = filter ? `/api/v1/print/jobs?document_type=${filter}` : '/api/v1/print/jobs'
      const { data } = await api.get<{ data: PrintJob[] }>(url)
      setJobs(data ?? [])
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [filter])

  useEffect(() => { load() }, [load])

  return (
    <Layout
      title="Центр друку"
      actions={
        <Button variant="secondary" size="sm" icon={<RefreshCw size={14} />} onClick={load}>
          Оновити
        </Button>
      }
    >
      <div className="mb-4 flex gap-2 flex-wrap">
        {['', 'receipt', 'label', 'order', 'picking_list'].map((t) => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              filter === t ? 'bg-yellow-100 text-yellow-800 border border-yellow-300' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {t ? DOC_TYPE_LABELS[t] : 'Всі'}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-16 text-gray-400 text-sm">Завантаження...</div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <Printer size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">Журнал порожній</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b">
                <th className="pb-2 pr-4 font-medium">Назва</th>
                <th className="pb-2 pr-4 font-medium">Тип</th>
                <th className="pb-2 pr-4 font-medium">Копій</th>
                <th className="pb-2 pr-4 font-medium">Статус</th>
                <th className="pb-2 font-medium">Час</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {jobs.map((j) => (
                <tr key={j.id} className="hover:bg-gray-50">
                  <td className="py-2 pr-4 text-gray-800 font-medium truncate max-w-[200px]">{j.title}</td>
                  <td className="py-2 pr-4 text-gray-500">{DOC_TYPE_LABELS[j.document_type] ?? j.document_type}</td>
                  <td className="py-2 pr-4 text-gray-500">{j.copies}</td>
                  <td className="py-2 pr-4">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      j.status === 'printed' ? 'bg-green-100 text-green-700'
                      : j.status === 'failed' ? 'bg-red-100 text-red-700'
                      : 'bg-gray-100 text-gray-600'
                    }`}>
                      {j.status === 'printed' ? 'Надруковано' : j.status === 'failed' ? 'Помилка' : 'Очікує'}
                    </span>
                  </td>
                  <td className="py-2 text-gray-400 text-xs">{fmt(j.printed_at ?? j.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>
  )
}
