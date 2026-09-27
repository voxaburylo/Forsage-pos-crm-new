import { useCallback, useEffect, useState } from 'react'
import { useAuthStore } from '@/stores/authStore'
import { useScopedAction } from '@/hooks/useScopedAction'
import { Button } from '@/components/ui'
import { warehouseApi, type WarehouseOperationKind } from './warehouseApi'

export type WarehouseResolution = { committed: number; notCommitted: number }
export function useWarehouseRecovery(kind: WarehouseOperationKind, enabled = true) {
  const userId = useAuthStore(s => s.session?.user?.id)
  const scope = JSON.stringify([kind, userId, enabled])
  const read = useCallback(() => {
    try { return { scope, pending: enabled ? warehouseApi.pendingOperations(kind) : [], error: '' } }
    catch (error) { return { scope, pending: [], error: error instanceof Error ? error.message : 'Не вдалося прочитати журнал складських операцій' } }
  }, [kind, scope, enabled])
  const [state, setState] = useState(read)
  const [message, setMessage] = useState('')
  const action = useScopedAction(scope)
  const refresh = useCallback(() => setState(read()), [read])
  useEffect(() => {
    refresh()
    setMessage('')
    window.addEventListener('forsage:warehouse-recovery', refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener('forsage:warehouse-recovery', refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [refresh])
  async function resolve(): Promise<WarehouseResolution | null> {
    const attempt = action.begin()
    if (!attempt) return null
    setMessage('')
    try {
      const pending = warehouseApi.pendingOperations(kind)
      const report = { committed: 0, notCommitted: 0 }
      for (const item of pending) {
        const result = await warehouseApi.resolveOperation(kind, item.operationId)
        if (!attempt.isCurrent()) return null
        if (result.status === 'committed') report.committed++
        else report.notCommitted++
      }
      refresh()
      setMessage(report.committed
        ? 'Операцію вже збережено. Повторний запис не виконувався.'
        : report.notCommitted ? 'Попередню спробу не проведено. Можна перевірити дані та зберегти.'
          : 'Незавершених спроб немає. Дані оновлено.')
      return report
    } catch (error) {
      if (attempt.isCurrent()) { refresh(); setMessage(error instanceof Error ? error.message : 'Не вдалося перевірити результат') }
      return null
    } finally { attempt.finish() }
  }
  return { blocked: enabled && (state.scope !== scope || !!state.error || state.pending.length > 0),
    error: state.error, message, busy: action.busy, refresh, resolve }
}

export function WarehouseRecoveryNotice({ recovery, disabled = false, onResolved }: {
  recovery: ReturnType<typeof useWarehouseRecovery>
  disabled?: boolean
  onResolved: (result: WarehouseResolution) => void
}) {
  if (!recovery.blocked && !recovery.message) return null
  return <div role="alert" className="my-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
    {recovery.blocked && <p>{recovery.error || 'Є складська операція без підтвердження. Перевірте її перед новим записом, щоб не змінити залишки двічі.'}</p>}
    {recovery.message && <p>{recovery.message}</p>}
    {recovery.blocked && <Button type="button" className="mt-2" disabled={disabled} loading={recovery.busy}
      onClick={async () => { const result = await recovery.resolve(); if (result) onResolved(result) }}>Перевірити операцію</Button>}
  </div>
}
