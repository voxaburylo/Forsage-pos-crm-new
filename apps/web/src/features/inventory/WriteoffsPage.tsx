import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Trash2 } from 'lucide-react'
import { writeoffApi } from './writeoffApi'
import { REASON_LABEL, REASON_COLOR } from '@/types/writeoff'
import type { Writeoff, PaginatedWriteoffs, WriteoffReason } from '@/types/writeoff'
import { Layout } from '@/components/Layout'
import { Button, Badge, Card, Table } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatDate, formatMoney } from '@/lib/utils'

const REASONS: Array<{ value: WriteoffReason | ''; label: string }> = [
  { value: '', label: 'Всі' },
  { value: 'damage', label: 'Пошкодження' },
  { value: 'expiry', label: 'Прострочення' },
  { value: 'loss',   label: 'Нестача' },
  { value: 'audit',  label: 'Інвентаризація' },
  { value: 'other',  label: 'Інше' },
]

export default function WriteoffsPage() {
  const navigate = useNavigate()
  const [result, setResult]   = useState<PaginatedWriteoffs | null>(null)
  const [reason, setReason]   = useState<WriteoffReason | ''>('')
  const [page, setPage]       = useState(1)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await writeoffApi.list({ reason: reason || undefined, page, per_page: 20 })
      setResult(data)
    } catch {
      toast.error('Помилка завантаження')
    } finally {
      setLoading(false)
    }
  }, [reason, page])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(1) }, [reason])

  const total = result?.pagination?.total ?? 0
  const pages = result?.pagination?.total_pages ?? 1

  const columns = [
    {
      key: 'date', header: 'Дата',
      render: (w: Writeoff) => (
        <button onClick={() => navigate('/inventory/writeoffs/' + w.id)}
          className="text-left hover:text-yellow-600 text-sm font-medium">
          {formatDate(w.created_at)}
        </button>
      ),
    },
    {
      key: 'reason', header: 'Причина', className: 'w-36',
      render: (w: Writeoff) => (
        <Badge color={REASON_COLOR[w.reason]}>{REASON_LABEL[w.reason]}</Badge>
      ),
    },
    {
      key: 'items', header: 'Позицій', className: 'w-24 text-center',
      render: (w: Writeoff) => w.items?.length ?? 0,
    },
    {
      key: 'cost', header: 'Собівартість', className: 'w-36 text-right',
      render: (w: Writeoff) => (
        <span className="font-mono text-sm">
          {formatMoney((w.items ?? []).reduce((s, i) => s + i.cost_kopecks, 0))}
        </span>
      ),
    },
    {
      key: 'notes', header: 'Нотатки', className: 'hidden lg:table-cell text-sm text-gray-500',
      render: (w: Writeoff) => w.notes ?? '—',
    },
  ]

  return (
    <Layout
      title={'Списання (' + total + ')'}
      actions={
        <Button icon={<Plus size={16} />} onClick={() => navigate('/inventory/writeoffs/new')}>
          Новий акт
        </Button>
      }
    >
      <div className="mb-4 flex gap-2 flex-wrap">
        {REASONS.map((r) => (
          <button key={r.value} onClick={() => setReason(r.value as WriteoffReason | '')}
            className={
              'px-3 py-1.5 text-sm rounded-lg transition-colors ' +
              (reason === r.value
                ? 'bg-yellow-400 text-white font-medium'
                : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300')
            }>
            {r.label}
          </button>
        ))}
      </div>

      <Card padding="none">
        <Table
          columns={columns}
          data={result?.data ?? []}
          keyFn={(w) => w.id}
          loading={loading}
          empty={
            <div className="flex flex-col items-center gap-2 text-gray-400 py-8">
              <Trash2 size={36} className="opacity-30" />
              <p className="text-sm">Актів списання немає</p>
            </div>
          }
        />
        {pages > 1 && (
          <div className="border-t border-gray-100 px-4 py-3 flex items-center justify-between text-sm text-gray-500">
            <span>Показано {(page - 1) * 20 + 1}–{Math.min(page * 20, total)} з {total}</span>
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
