import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ClipboardList, Download, RefreshCw } from 'lucide-react'
import { Button, Card, ConfirmDialog } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { desktopBridge, type DesktopProblem } from '@/lib/desktopBridge'

const SOURCE_LABELS: Record<DesktopProblem['source'], string> = {
  sync: 'Синхронізація',
  print: 'Друк',
  fiscal: 'ПРРО',
  database: 'База даних',
  app: 'Програма',
}

function formatMoment(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/**
 * Журнал проблем каси. Раніше збій було видно лише в консолі розробника: товар
 * не долітав на сервер, прихід не зараховувався, а на касі це виглядало як
 * «кількість не та». Тепер кожна така подія лишає слід, який можна прочитати
 * ввечері при звірці й віддати на виправлення.
 */
export function ProblemLogCard() {
  const [problems, setProblems] = useState<DesktopProblem[]>([])
  const [includeResolved, setIncludeResolved] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  const load = useCallback(async () => {
    const api = desktopBridge()?.problems
    if (!api) return
    setLoading(true)
    try {
      setProblems(await api.list({ includeResolved }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося прочитати журнал')
    } finally {
      setLoading(false)
    }
  }, [includeResolved])

  useEffect(() => { void load() }, [load])

  const openCount = useMemo(
    () => problems.filter((problem) => !problem.resolved_at).length,
    [problems],
  )

  async function handleResolve(problem: DesktopProblem) {
    const api = desktopBridge()?.problems
    if (!api) return
    setBusyId(problem.id)
    try {
      await api.resolve(problem.id)
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося закрити запис')
    } finally {
      setBusyId(null)
    }
  }

  async function handleExport() {
    const api = desktopBridge()?.problems
    if (!api) return
    try {
      const result = await api.export()
      toast.success(`Журнал збережено: ${result.path}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося зберегти журнал')
    }
  }

  return (
    <Card className="mt-6 space-y-4 border-slate-200">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 pb-2">
            <ClipboardList size={18} className="text-slate-600" />
            <h3 className="text-sm font-semibold text-slate-900">Журнал проблем</h3>
            {openCount > 0 && (
              <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
                {openCount}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-600">
            Сюди потрапляє все, що каса не змогла виконати: відхилені сервером
            операції, збої друку, ПРРО та бази. Якщо кількість товару чи картка
            не збігаються з сервером — причина буде тут.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>
            Оновити
          </Button>
          <Button type="button" variant="secondary" size="sm" icon={<Download size={14} />} onClick={handleExport}>
            Зберегти у файл
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300"
            checked={includeResolved}
            onChange={(event) => setIncludeResolved(event.target.checked)}
          />
          Показати також закриті
        </label>
        {openCount > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmClear(true)}>
            Закрити всі
          </Button>
        )}
      </div>

      {problems.length === 0 ? (
        <p className="rounded-lg bg-slate-50 px-3 py-4 text-center text-sm text-slate-500">
          {loading ? 'Завантаження…' : 'Проблем не зафіксовано.'}
        </p>
      ) : (
        <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {problems.map((problem) => (
            <div key={problem.id} className="flex items-start justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  {!problem.resolved_at && (
                    <AlertTriangle
                      size={14}
                      className={problem.severity === 'error' ? 'text-red-600' : 'text-amber-500'}
                    />
                  )}
                  <p className={`text-sm font-medium ${problem.resolved_at ? 'text-slate-400 line-through' : 'text-slate-800'}`}>
                    {problem.title}
                  </p>
                  {problem.occurrences > 1 && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                      ×{problem.occurrences}
                    </span>
                  )}
                </div>
                {problem.detail && (
                  <p className="mt-0.5 break-words text-xs text-slate-500">{problem.detail}</p>
                )}
                <p className="mt-0.5 text-xs text-slate-400">
                  {SOURCE_LABELS[problem.source] ?? problem.source} · {formatMoment(problem.last_seen_at)}
                </p>
              </div>
              {!problem.resolved_at && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  loading={busyId === problem.id}
                  onClick={() => void handleResolve(problem)}
                  className="shrink-0"
                >
                  Закрити
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={async () => {
          const api = desktopBridge()?.problems
          if (!api) return
          try {
            const result = await api.resolveAll()
            toast.success(`Закрито записів: ${result.resolved}`)
            await load()
          } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Не вдалося закрити записи')
          }
        }}
        title="Закрити всі записи журналу?"
        message={'Записи лишаться в історії, але зникнуть зі списку відкритих. '
          + 'Закривайте лише те, що вже виправлено, — інакше проблема залишиться непоміченою.'}
        confirmLabel="Закрити всі"
      />
    </Card>
  )
}
