import { useEffect } from 'react'
import { api } from '@/lib/api'
import { desktopBridge, isDesktopRuntime } from '@/lib/desktopBridge'
import { isDesktopAccessLocked } from '@/lib/desktopAccessState'
import { canUseCloudBackground } from '@/lib/lanFirstRun'
import { useAuthStore } from '@/stores/authStore'
import { planTillProductUpdate, type TillProductUpdate } from '@/features/tillCommands/tillCommandModel'

interface ClaimedCommand { id: string; operation_id: string; command: string; payload: unknown }
const POLL_MS = 5_000

/**
 * Каса виконує зміни, поставлені з вебу (рішення власника 17.11.2026).
 * Лише головна каса (не ПК менеджера), лише коли є сервер. Кожна команда забирається з сервера один раз.
 */
export function useTillCommands(serverOnline: boolean) {
  const user = useAuthStore(state => state.session?.user)
  const offlineMode = useAuthStore(state => state.offlineMode)
  useEffect(() => {
    const bridge = desktopBridge()
    if (!isDesktopRuntime() || !bridge?.catalog?.findById || !serverOnline || offlineMode || !user) return
    let stopped = false, busy = false, deviceId = ''
    async function execute(command: ClaimedCommand): Promise<{ status: 'done' | 'failed'; result?: Record<string, unknown> | null; error?: string | null }> {
      try {
        if (command.command !== 'product.update') throw new Error('Невідома команда. Оновіть програму на касі.')
        const update = command.payload as TillProductUpdate
        const current = await bridge!.catalog.findById!(String(update?.product_id ?? ''))
        const form = planTillProductUpdate(current, update)
        // Модуль товарів підвантажуємо лише коли команда справді прийшла: фоновий агент лишається легким.
        const { productApi } = await import('@/features/products/productApi')
        const saved = await productApi.update(update.product_id, form)
        return { status: 'done', result: { product_id: saved.data.id, name: saved.data.name, sku: saved.data.sku, retail_price: saved.data.retail_price } }
      } catch (error) {
        return { status: 'failed', error: (error instanceof Error ? error.message : 'Каса не змогла виконати зміну').slice(0, 500) }
      }
    }
    async function run() {
      if (stopped || busy || isDesktopAccessLocked()) return
      busy = true
      try {
        if (!await canUseCloudBackground() || stopped) return
        deviceId ||= (await bridge!.getRuntimeInfo()).deviceId
        const { data } = await api.post<{ data: ClaimedCommand[] }>('/api/v1/till-commands/claim', { device_id: deviceId }, undefined, { silent: true, timeoutMs: 10_000 })
        for (const command of data) {
          const outcome = await execute(command)
          await api.post(`/api/v1/till-commands/${command.id}/result`, { device_id: deviceId, outcome }, undefined, { silent: true, timeoutMs: 10_000 }).catch(() => {})
        }
      } catch { /* наступне опитування повторить; веб покаже «каса не в мережі» */ }
      finally { busy = false }
    }
    const timer = window.setInterval(() => { void run() }, POLL_MS)
    void run()
    return () => { stopped = true; window.clearInterval(timer) }
  }, [serverOnline, offlineMode, user?.id])
}
