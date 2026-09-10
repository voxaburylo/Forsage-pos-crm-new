import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

export function useReportRows<T>(url: string, valid = true) {
  const [revision, setRevision] = useState(0)
  const key = url + ':' + revision
  const [state, setState] = useState<{ key: string; rows: T[]; error: string; pending: boolean }>({
    key: '', rows: [], error: '', pending: true,
  })
  useEffect(() => {
    let active = true
    if (!valid) return
    setState({ key, rows: [], error: '', pending: true })
    api.get<{ data: T[] }>(url).then((response) => {
      if (!Array.isArray(response.data)) throw new Error('Сервер повернув неповний звіт')
      if (active) setState({ key, rows: response.data, error: '', pending: false })
    }).catch((error) => {
      if (active) setState({ key, rows: [], error: error instanceof Error ? error.message : 'Не вдалося завантажити звіт', pending: false })
    })
    return () => { active = false }
  }, [key, url, valid])
  const current = state.key === key
  return {
    rows: valid && current ? state.rows : [],
    loading: valid && (!current || state.pending),
    error: !valid ? 'Дата початку має бути не пізніше дати завершення' : current ? state.error : '',
    retry: () => setRevision((value) => value + 1),
  }
}
