import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { freshnessAgeMinutes, STALE_AFTER_MINUTES } from '@/components/DataFreshness'

/**
 * Звідки цифри звіту. 21.11.2026 (план «порядок в аналітиці»): звіти, що рахуються на сервері
 * (Контроль, ABC, прибутковість працівників), на касі помилково підписувались «локальна база».
 * Тепер серверне джерело показує, станом на коли копія з каси, і попереджає, якщо їй понад 30 хв.
 */
export function ReportSourceNote({ local, server = false }: { local: boolean; server?: boolean }) {
  const serverSource = server || !local
  const [lastAt, setLastAt] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    if (!serverSource) return
    let alive = true
    api.get<{ data: { last_local_data_at: string | null } }>('/api/v1/sync/freshness', { silent: true, timeoutMs: 15_000 })
      .then(({ data }) => { if (alive) setLastAt(data.last_local_data_at) })
      .catch(() => { if (alive) setLastAt(null) })
    return () => { alive = false }
  }, [serverSource])

  if (!serverSource) {
    return <p className="mb-3 text-xs text-gray-500" data-testid="report-source">Джерело: локальна база магазину.</p>
  }
  const age = lastAt ? freshnessAgeMinutes(lastAt) : null
  const stale = age === null || age > STALE_AFTER_MINUTES
  const when = lastAt ? new Date(lastAt).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null
  return (
    <p className={`mb-3 text-xs ${lastAt !== undefined && stale ? 'rounded-lg bg-amber-50 px-2 py-1 text-amber-800' : 'text-gray-500'}`} data-testid="report-source">
      Джерело: серверна копія з каси{when ? ` станом на ${when}` : ''}.
      {!lastAt ? ' Вона може відставати від каси; час повноти даних не підтверджено.'
        : stale ? ' Копія давніша за 30 хвилин — свіжі продажі каси ще можуть не входити у звіт.' : ''}
    </p>
  )
}
