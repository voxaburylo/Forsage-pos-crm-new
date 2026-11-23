import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, HelpCircle, RefreshCw, XCircle } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Button, Card } from '@/components/ui'
import { api } from '@/lib/api'
import { OVERALL_TEXT, type Level, type SystemStatus, ago, overallLevel, statusLines } from './systemStatusModel'

const REFRESH_MS = 30_000

const TONE: Record<Level, { box: string; text: string; icon: React.ReactNode }> = {
  ok: { box: 'border-emerald-200 bg-emerald-50', text: 'text-emerald-800', icon: <CheckCircle2 size={18} className="text-emerald-600" aria-hidden="true" /> },
  warn: { box: 'border-amber-200 bg-amber-50', text: 'text-amber-900', icon: <AlertTriangle size={18} className="text-amber-600" aria-hidden="true" /> },
  bad: { box: 'border-red-200 bg-red-50', text: 'text-red-800', icon: <XCircle size={18} className="text-red-600" aria-hidden="true" /> },
  unknown: { box: 'border-gray-200 bg-gray-50', text: 'text-gray-700', icon: <HelpCircle size={18} className="text-gray-400" aria-hidden="true" /> },
}

/**
 * «Стан системи» (план T2, 23.11.2026) — для власника з телефона: чи на звʼязку каса, яка версія, вікно чи фон,
 * чи все передано на сервер, коли була остання копія бази, скільки місця на диску, чи були помилки сервера.
 */
export default function SystemStatusPage() {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const answer = await api.get<{ data: SystemStatus }>('/api/v1/system/status', { silent: true, timeoutMs: 15_000 })
      setStatus(answer.data); setError(''); setNow(Date.now())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не вдалося отримати стан системи')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [load])

  const lines = status ? statusLines(status, now) : []
  const overall = overallLevel(lines)

  return (
    <Layout title="Стан системи" actions={<Button variant="secondary" size="sm" icon={<RefreshCw size={14} />} loading={loading} onClick={() => void load()}>Оновити</Button>}>
      <div className="mx-auto max-w-2xl space-y-4">
        {error && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{error}</p>}
        {!status && !error && <p role="status" className="py-8 text-center text-sm text-gray-500">Завантажуємо…</p>}
        {status && (
          <>
            <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${TONE[overall].box}`} data-system-overall={overall}>
              {TONE[overall].icon}
              <p className={`text-base font-semibold ${TONE[overall].text}`}>{OVERALL_TEXT[overall]}</p>
            </div>
            <Card>
              <ul className="divide-y divide-gray-100">
                {lines.map(line => (
                  <li key={line.id} className="flex items-start gap-3 py-3" data-system-line={line.id} data-level={line.level}>
                    <span className="mt-0.5 shrink-0">{TONE[line.level].icon}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs uppercase tracking-wide text-gray-500">{line.label}</p>
                      <p className={`text-sm font-medium ${line.level === 'bad' ? 'text-red-800' : line.level === 'warn' ? 'text-amber-900' : 'text-gray-900'}`}>{line.value}</p>
                      {line.hint && <p className="mt-0.5 text-xs text-gray-500">{line.hint}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
            {status.errors.rows.length > 0 && (
              <Card>
                <h2 className="font-semibold text-gray-800">Помилки сервера за добу</h2>
                <ul className="mt-2 divide-y divide-gray-100 text-sm">
                  {status.errors.rows.map((row, index) => (
                    <li key={index} className="py-2">
                      <p className="text-xs text-gray-500">{ago(row.created_at, now)}{row.repeats > 1 ? ` · повторів: ${row.repeats}` : ''}{row.route ? ` · ${row.route}` : ''}</p>
                      <p className="font-mono text-xs text-gray-800">{row.code ? `${row.code}: ` : ''}{row.message}</p>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            <p className="text-center text-xs text-gray-400">Сервер: збірка {status.server.build ?? 'невідома'} · оновлюється щопівхвилини</p>
          </>
        )}
      </div>
    </Layout>
  )
}
