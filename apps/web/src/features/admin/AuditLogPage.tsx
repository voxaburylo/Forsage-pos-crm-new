import { useState, useEffect, useCallback } from 'react'
import { Shield } from 'lucide-react'
import { auditApi } from './auditApi'
import { ACTION_LABEL, ACTION_COLOR } from '@/types/auditLog'
import type { AuditLog, PaginatedAuditLog } from '@/types/auditLog'
import { Layout } from '@/components/Layout'
import { Badge, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatDateTime } from '@/lib/utils'

const ENTITY_TYPES = [
  { value: '',        label: 'Всі' },
  { value: 'sale',    label: 'Продажі' },
  { value: 'return',  label: 'Повернення' },
  { value: 'product', label: 'Товари' },
  { value: 'writeoff', label: 'Списання' },
]

export default function AuditLogPage() {
  const [result, setResult]       = useState<PaginatedAuditLog | null>(null)
  const [entityType, setEntityType] = useState('')
  const [dateFrom, setDateFrom]   = useState('')
  const [dateTo, setDateTo]       = useState('')
  const [page, setPage]           = useState(1)
  const [loading, setLoading]     = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await auditApi.list({
        entity_type: entityType || undefined,
        date_from:   dateFrom || undefined,
        date_to:     dateTo || undefined,
        page,
        per_page:    50,
      })
      setResult(data)
    } catch {
      toast.error('Помилка завантаження')
    } finally {
      setLoading(false)
    }
  }, [entityType, dateFrom, dateTo, page])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(1) }, [entityType, dateFrom, dateTo])

  const total = result?.pagination?.total ?? 0
  const pages = result?.pagination?.total_pages ?? 1

  function formatValue(val: Record<string, unknown> | null): string {
    if (!val) return '—'
    return Object.entries(val)
      .map(([k, v]) => k + ': ' + String(v))
      .join(', ')
  }

  return (
    <Layout title={'Журнал дій (' + total + ')'}>
      {/* Фільтри */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Тип подій</label>
            <select value={entityType} onChange={(e) => setEntityType(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400">
              {ENTITY_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Від</label>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">До</label>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400" />
          </div>
          {(dateFrom || dateTo || entityType) && (
            <button onClick={() => { setEntityType(''); setDateFrom(''); setDateTo('') }}
              className="text-sm text-gray-400 hover:text-gray-600">
              Скинути
            </button>
          )}
        </div>
      </Card>

      {/* Таблиця */}
      <Card padding="none">
        {loading ? (
          <div className="py-16 text-center text-gray-400 text-sm">Завантаження...</div>
        ) : result?.data.length === 0 ? (
          <div className="py-16 text-center text-gray-400">
            <Shield size={40} className="mx-auto mb-2 opacity-20" />
            <p className="text-sm">Подій не знайдено</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 uppercase border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 w-40">Час</th>
                <th className="text-left px-4 py-3 w-36">Користувач</th>
                <th className="text-left px-4 py-3 w-40">Дія</th>
                <th className="text-left px-4 py-3">Об'єкт</th>
                <th className="text-left px-4 py-3 hidden lg:table-cell">Деталі</th>
              </tr>
            </thead>
            <tbody>
              {(result?.data ?? []).map((log: AuditLog) => (
                <tr key={log.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                  <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">
                    {formatDateTime(log.created_at)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="font-mono text-xs text-gray-600">{log.user_name}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge color={(ACTION_COLOR[log.action] ?? 'gray') as 'green' | 'orange' | 'blue' | 'red' | 'gray'}>
                      {ACTION_LABEL[log.action] ?? log.action}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-gray-700">{log.entity_label ?? log.entity_id ?? '—'}</span>
                  </td>
                  <td className="px-4 py-2.5 hidden lg:table-cell">
                    {log.old_value && (
                      <span className="text-xs text-gray-400 line-through mr-2">{formatValue(log.old_value)}</span>
                    )}
                    {log.new_value && (
                      <span className="text-xs text-gray-600">{formatValue(log.new_value)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {pages > 1 && (
          <div className="border-t border-gray-100 px-4 py-3 flex items-center justify-between text-sm text-gray-500">
            <span>Показано {(page - 1) * 50 + 1}–{Math.min(page * 50, total)} з {total}</span>
            <div className="flex gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                className="px-3 py-1 border border-gray-200 rounded-lg disabled:opacity-40">←</button>
              <span className="px-3 py-1 bg-gray-100 rounded-lg font-medium">{page}/{pages}</span>
              <button onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page === pages}
                className="px-3 py-1 border border-gray-200 rounded-lg disabled:opacity-40">→</button>
            </div>
          </div>
        )}
      </Card>
    </Layout>
  )
}
