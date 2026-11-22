import { useEffect } from 'react'
import { api } from '@/lib/api'
import { desktopBridge, isDesktopRuntime } from '@/lib/desktopBridge'
import { isDesktopAccessLocked } from '@/lib/desktopAccessState'
import { canUseCloudBackground } from '@/lib/lanFirstRun'
import { supabase } from '@/lib/supabase'
import { decodeRpcValue, encodeRpcValue } from '@/lib/tillRpcCodec'
import { useAuthStore } from '@/stores/authStore'

interface ClaimedRequest { id: string; user_id: string; channel: string; args: unknown[] }
const POLL_MS = 3_000

/**
 * 22.11.2026, рішення власника «веб повний, але тільки через головний ПК».
 * Головна каса забирає запити вебу (одразу за сигналом сервера, інакше кожні 3 с), виконує кожен у своїй базі
 * від імені працівника з вебу (головний процес перевіряє канал і права) і повертає відповідь.
 * Каса не на зв'язку — запит гасне за 30 с, нічого не виконано.
 */
export function useTillRpc(serverOnline: boolean) {
  const user = useAuthStore(state => state.session?.user)
  const offlineMode = useAuthStore(state => state.offlineMode)
  const tenantId = String(user?.app_metadata?.tenant_id ?? '')
  useEffect(() => {
    const bridge = desktopBridge()
    const execute = bridge?.auth?.executeWebRequest
    if (!isDesktopRuntime() || !execute || !serverOnline || offlineMode || !user || !tenantId) return
    let stopped = false, busy = false, again = false, deviceId = ''
    async function run(): Promise<void> {
      if (stopped) return
      if (busy) { again = true; return }
      if (isDesktopAccessLocked()) return
      busy = true
      try {
        if (!await canUseCloudBackground() || stopped) return
        deviceId ||= (await bridge!.getRuntimeInfo()).deviceId
        const { data } = await api.post<{ data: ClaimedRequest[] }>('/api/v1/till-rpc/claim', { device_id: deviceId }, undefined, { silent: true, timeoutMs: 10_000 })
        await Promise.all(data.map(async request => {
          let outcome: { status: 'done' | 'failed'; result?: unknown; error?: string }
          try {
            const result = await execute!(request.user_id, request.channel, decodeRpcValue(request.args) as unknown[])
            outcome = { status: 'done', result: encodeRpcValue(result ?? null) }
          } catch (error) {
            outcome = { status: 'failed', error: (error instanceof Error ? error.message : 'Каса не змогла виконати дію').slice(0, 1000) }
          }
          await api.post(`/api/v1/till-rpc/${request.id}/result`, { device_id: deviceId, outcome }, undefined, { silent: true, timeoutMs: 15_000 }).catch(() => {})
        }))
      } catch { /* наступний сигнал чи опитування повторить */ }
      finally {
        busy = false
        if (again && !stopped) { again = false; void run() }
      }
    }
    // Сигнал без даних: сервер лише будить касу, сам запит каса забирає своїм входом.
    const channel = supabase.channel(`till-rpc-${tenantId}`)
      .on('broadcast', { event: 'wake' }, () => { void run() })
      .subscribe()
    const timer = window.setInterval(() => { void run() }, POLL_MS)
    void run()
    return () => { stopped = true; window.clearInterval(timer); void supabase.removeChannel(channel) }
  }, [serverOnline, offlineMode, user?.id, tenantId])
}
