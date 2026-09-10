import { useEffect } from 'react'
import { desktopBridge } from '@/lib/desktopBridge'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'

export function useShiftBackups(serverOnline: boolean) {
  const user = useAuthStore(state => state.session?.user)
  useEffect(() => {
    const backup = desktopBridge()?.shiftBackups
    if (!backup || !serverOnline || !user || !['owner','admin','cashier'].includes(String(user.app_metadata?.role))) return
    let stopped = false, busy = false
    let delayUntil = 0, failures = 0
    async function run() {
      if (stopped || busy || Date.now() < delayUntil) return
      busy = true
      let id = ''
      try {
        const [job] = await backup!.pending()
        if (!job || stopped) return
        id = job.id
        const prepared = await api.post<{ data: { signed_url?: string; already_uploaded?: boolean } }>('/api/v1/backups/prepare', job)
        if (stopped) return
        if (!prepared.data.already_uploaded) {
          if (!prepared.data.signed_url) throw new Error('Сервер не повернув адресу резервування')
          await backup!.upload(id, prepared.data.signed_url)
        }
        const checked = await api.post<{ data: { sha256: string } }>('/api/v1/backups/verify', job, undefined, { timeoutMs: 120_000 })
        if (checked.data.sha256 !== job.sha256) throw new Error('Контрольна сума серверної копії не збігається')
        await backup!.confirmed(id, job.sha256)
        failures = 0
      } catch (error) {
        delayUntil = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(++failures, 5))
        if (id) await backup!.failed(id, error instanceof Error ? error.message : 'Резервування не вдалося').catch(() => {})
      } finally { busy = false }
    }
    const timer = window.setInterval(() => { void run() }, 30_000)
    const wake = () => { void run() }
    window.addEventListener('forsage:desktop-sync-requested', wake)
    void run()
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener('forsage:desktop-sync-requested',wake) }
  }, [serverOnline, user?.id])
}
