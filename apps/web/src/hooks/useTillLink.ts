import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { desktopBridge, isDesktopRuntime, type TillLinkStatus } from '@/lib/desktopBridge'
import { isDesktopAccessLocked } from '@/lib/desktopAccessState'
import { canUseCloudBackground } from '@/lib/lanFirstRun'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { LINK_FAST_HOLD_MS, nextBeatDelay } from './tillLinkTiming'
import { claimTillCommands } from './useTillCommands'
import { claimWebRequests } from './useTillRpc'

interface Beat { rpc: boolean; commands: boolean; web_active: boolean }
/** device — зв'язок тримає сама програма ключем ПК; session — вікно програми під сесією працівника. */
type LinkMode = 'unknown' | 'device' | 'session'
/** Як часто вікно питає програму (не сервер), чи є команди для нього. */
const COMMANDS_CHECK_MS = 5_000
const DEVICE_RECHECK_MS = 60_000
export const LINK_KEY_ROLES: readonly string[] = ['owner', 'admin']

/**
 * Зв'язок головного ПК із сервером (22.11.2026, «каса головна; сервер — лише передавач»).
 *
 * Основний спосіб — ключ самого ПК: запити вебу забирає й виконує головний процес програми, тож веб працює
 * через ПК і на екрані входу, і після перезапуску. Ключ видає сервер, коли на головному ПК увійшов власник
 * чи адміністратор; далі це відбувається саме. Вікно програми в цьому режимі лише ловить сигнал сервера
 * («є робота») і виконує команди, яким потрібна сесія працівника (замовлення з телефона, зміна, картка).
 *
 * Запасний спосіб — як раніше, під сесією того, хто увійшов: старий сервер, ключа ще немає.
 * В обох способах: одне легке «чи є робота» раз на 30 с, часто — лише поки у вебі працюють.
 * Сигнал зараз іде через Supabase Realtime; на власному сервері зміниться лише ця підписка.
 */
export function useTillLink(serverOnline: boolean) {
  const user = useAuthStore(state => state.session?.user)
  const offlineMode = useAuthStore(state => state.offlineMode)
  const tenantId = String(user?.app_metadata?.tenant_id ?? '')
  const role = String(user?.app_metadata?.role ?? '')
  const [link, setLink] = useState<{ mode: LinkMode; tenantId: string }>({ mode: 'unknown', tenantId: '' })

  // 1. Хто тримає зв'язок. Ключа ще немає, а на головному ПК увійшов власник чи адміністратор — беремо ключ із сервера.
  useEffect(() => {
    const bridge = desktopBridge()
    if (!isDesktopRuntime() || !bridge) return
    const deviceLink = bridge.link
    const settle = (mode: LinkMode, tenant = '') => setLink(previous => previous.mode === mode && previous.tenantId === tenant ? previous : { mode, tenantId: tenant })
    if (!deviceLink) { settle('session'); return }
    let stopped = false
    async function check() {
      let status: TillLinkStatus | null = await deviceLink!.status().catch(() => null)
      if (stopped) return
      if (status?.main_till && !status.registered && serverOnline && !offlineMode && user && LINK_KEY_ROLES.includes(role) && !isDesktopAccessLocked()) {
        try {
          if (await canUseCloudBackground()) {
            const deviceId = (await bridge!.getRuntimeInfo()).deviceId
            const { data } = await api.post<{ data: { token: string } }>('/api/v1/till-device/register', { device_id: deviceId }, undefined, { silent: true, timeoutMs: 15_000 })
            status = await deviceLink!.register(data.token)
          }
        } catch { /* старий сервер або немає мережі: зв'язок лишається під сесією працівника */ }
      }
      if (stopped) return
      if (status?.registered) settle('device', status.tenant_id ?? '')
      else settle('session')
    }
    void check()
    const timer = window.setInterval(() => { void check() }, DEVICE_RECHECK_MS)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [serverOnline, offlineMode, user?.id, role])

  // 2. Ключ ПК: вікно передає програмі сигнал сервера й виконує команди, яким потрібна сесія працівника.
  useEffect(() => {
    const bridge = desktopBridge(), deviceLink = bridge?.link
    if (link.mode !== 'device' || !bridge || !deviceLink || !serverOnline) return
    let stopped = false, busy = false, deviceId = ''
    async function runCommands(status: TillLinkStatus | null): Promise<void> {
      if (stopped || busy || !status?.commands_pending || !user || offlineMode || isDesktopAccessLocked()) return
      busy = true
      try {
        if (!await canUseCloudBackground() || stopped) return
        deviceId ||= (await bridge!.getRuntimeInfo()).deviceId
        await claimTillCommands({ bridge: bridge!, deviceId })
        await deviceLink!.commandsTaken()
      } catch { /* наступна перевірка повторить */ }
      finally { busy = false }
    }
    // Сигнал без даних: сервер лише будить касу, саму роботу програма забирає своїм ключем.
    const channel = link.tenantId
      ? supabase.channel(`till-rpc-${link.tenantId}`).on('broadcast', { event: 'wake' }, () => { void deviceLink.wake().then(runCommands, () => undefined) }).subscribe()
      : null
    const timer = window.setInterval(() => { void deviceLink.status().then(runCommands, () => undefined) }, COMMANDS_CHECK_MS)
    return () => { stopped = true; window.clearInterval(timer); if (channel) void supabase.removeChannel(channel) }
  }, [link.mode, link.tenantId, serverOnline, offlineMode, user?.id])

  // 3. Ключа ПК немає: зв'язок тримає вікно програми під сесією того, хто увійшов (як до 22.11.2026).
  useEffect(() => {
    const bridge = desktopBridge()
    if (link.mode !== 'session' || !isDesktopRuntime() || !bridge || !serverOnline || offlineMode || !user || !tenantId) return
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
    const channel = supabase.channel(`till-rpc-${tenantId}`)
      .on('broadcast', { event: 'wake' }, () => { void beat(true) })
      .subscribe()
    void beat(false)
    return () => { stopped = true; window.clearTimeout(timer); void supabase.removeChannel(channel) }
  }, [link.mode, serverOnline, offlineMode, user?.id, tenantId])
}
