import { desktopBridge, isDesktopRuntime } from '@/lib/desktopBridge'
import { businessDateKey, businessDateRangeUtc } from '@/lib/businessDate'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { abcDateRange } from './abcData'

export function useReportRows<T>(url: string, valid = true, parseRows?: (data: unknown) => T[]) {
  const [revision, setRevision] = useState(0)
  const key = url + ':' + revision
  const [state, setState] = useState<{ key: string; rows: T[]; error: string; pending: boolean }>({
    key: '', rows: [], error: '', pending: true,
  })
  useEffect(() => {
    let active = true
    if (!valid) return
    setState({ key, rows: [], error: '', pending: true })
    const load = async (): Promise<{data:T[]}> => {
      if (!isDesktopRuntime()) return api.get<{data:T[]}>(url)
      const local = desktopBridge()?.catalog.analytics
      if (!local) throw new Error('Для локальної аналітики запустіть оновлену програму')
      const parsed = new URL(url, 'https://local.invalid')
      const kind = parsed.pathname.endsWith('/abc') ? 'abc' : 'staff'
      const { startDate, endDate } = kind === 'abc'
        ? abcDateRange(parsed.searchParams.get('days') ?? '90')
        : { startDate: parsed.searchParams.get('startDate') || businessDateKey(new Date(Date.now() - 90*86400000)),
          endDate: parsed.searchParams.get('endDate') || businessDateKey() }
      return { data: await local({kind,startDate,endDate,...businessDateRangeUtc(startDate,endDate)}) as T[] }
    }
    load().then((response) => {
      if (!Array.isArray(response.data)) throw new Error('Сервер повернув неповний звіт')
      const rows = parseRows ? parseRows(response.data) : response.data
      if (active) setState({ key, rows, error: '', pending: false })
    }).catch((error) => {
      if (active) setState({ key, rows: [], error: error instanceof Error ? error.message : 'Не вдалося завантажити звіт', pending: false })
    })
    return () => { active = false }
  }, [key, url, valid, parseRows])
  const current = state.key === key
  return {
    rows: valid && current ? state.rows : [],
    loading: valid && (!current || state.pending),
    error: !valid ? 'Дата початку має бути не пізніше дати завершення' : current ? state.error : '',
    retry: () => setRevision((value) => value + 1),
  }
}
