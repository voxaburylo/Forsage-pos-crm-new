import { useEffect } from 'react'
import { api } from '@/lib/api'
import { desktopBridge, isDesktopRuntime } from '@/lib/desktopBridge'
import { isDesktopAccessLocked } from '@/lib/desktopAccessState'
import { canUseCloudBackground } from '@/lib/lanFirstRun'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { LINK_FAST_HOLD_MS, nextBeatDelay } from './tillLinkTiming'
import { claimTillCommands } from './useTillCommands'
import { claimWebRequests } from './useTillRpc'

interface Beat { rpc: boolean; commands: boolean; web_active: boolean }

/**
 * Зв'язок головного ПК із сервером (22.11.2026, «каса головна; сервер — лише передавач»).
 * Одне легке «чи є для мене робота» замість двох опитувань щокілька секунд. Запит вебу чи нова команда
 * будять касу сигналом одразу; рідке опитування — страховка на випадок, якщо сигнал не дійшов.
 * Сигнал зараз іде через Supabase Realtime; на власному сервері зміниться лише ця підписка.
 * Лише головна каса (не ПК менеджера), лише коли є сервер і хтось увійшов у програму.
 */
export function useTillLink(serverOnline: boolean) {
  const user = useAuthStore(state => state.session?.user)
  const offlineMode = useAuthStore(state => state.offlineMode)
  const tenantId = String(user?.app_metadata?.tenant_id ?? '')
  useEffect(() => {
    const bridge = desktopBridge()
    if (!isDesktopRuntime() || !bridge || !serverOnline || offlineMode || !user || !tenantId) return
    let stopped = false, busy = false, again = false, legacy = false, fastUntil = 0, timer = 0, deviceId = ''
    const schedule = () => {
      window.clearTimeout(timer)
      if (!stopped) timer = window.setTimeout(() => { void beat(false) }, nextBeatDelay(Date.now(), fastUntil, legacy))
    }
    async function beat(woken: boolean): Promise<void> {
      if (stopped) return
      if (busy) { again = again || woken; return }
      busy = true
      try {
        if (isDesktopAccessLocked() || !await canUseCloudBackground() || stopped) return
        deviceId ||= (await bridge!.getRuntimeInfo()).deviceId
        let work: Beat = { rpc: true, commands: true, web_active: woken }
        // Після сигналу питати «чи є робота» зайве — одразу забираємо.
        if (!woken && !legacy) {
          try {
            const answer = (await api.post<{ data?: Partial<Beat> }>('/api/v1/till-link/beat', { device_id: deviceId }, undefined, { silent: true, timeoutMs: 10_000 })).data
            work = { rpc: Boolean(answer?.rpc), commands: Boolean(answer?.commands), web_active: Boolean(answer?.web_active) }
          } catch (error) {
            if (Number((error as { status?: number })?.status) !== 404) return
            legacy = true
          }
        }
        if (work.web_active) fastUntil = Date.now() + LINK_FAST_HOLD_MS
        const context = { bridge: bridge!, deviceId }
        const [requests, commands] = await Promise.all([
          work.rpc ? claimWebRequests(context) : 0,
          work.commands ? claimTillCommands(context) : 0,
        ])
        if (requests + commands > 0) fastUntil = Date.now() + LINK_FAST_HOLD_MS
      } catch { /* наступний сигнал чи опитування повторить; веб покаже «каса не на зв'язку» */ }
      finally {
        busy = false
        if (again && !stopped) { again = false; void beat(true) } else schedule()
      }
    }
    // Сигнал без даних: сервер лише будить касу, саму роботу каса забирає своїм входом.
    const channel = supabase.channel(`till-rpc-${tenantId}`)
      .on('broadcast', { event: 'wake' }, () => { void beat(true) })
      .subscribe()
    void beat(false)
    return () => { stopped = true; window.clearTimeout(timer); void supabase.removeChannel(channel) }
  }, [serverOnline, offlineMode, user?.id, tenantId])
}
