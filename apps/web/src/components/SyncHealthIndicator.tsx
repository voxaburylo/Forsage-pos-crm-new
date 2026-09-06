import { useState } from 'react'
import { AlertTriangle, CloudUpload } from 'lucide-react'
import { SyncHealthModal } from './SyncHealthModal'
import { syncHealthLabel, useDesktopSyncHealth } from '@/hooks/useDesktopSyncHealth'
import { useAuthStore } from '@/stores/authStore'

interface Props {
  /** `dark` — для темної каси, `light` — для звичайної шапки. */
  theme?: 'light' | 'dark'
  className?: string
}

/** Черга — не робота касира: значок бачить лише той, хто звіряє дані. */
const SYNC_WATCHER_ROLES = new Set(['owner', 'admin'])

/**
 * Показує власнику, скільки локальних операцій ще не доїхало на сервер.
 *
 * Касиру значок не показуємо свідомо: за чергою не можна «чергувати», вона
 * має розсмоктуватись сама, а зайвий тривожний значок на робочому екрані лише
 * відволікає від покупця. Якщо щось не лікується повторами — це видно власнику
 * тут і в журналі проблем при вечірній звірці.
 *
 * Так само нічого не показуємо, коли все синхронізовано: постійний зелений
 * значок швидко стає фоном, і тоді червоний теж перестають помічати.
 */
export function SyncHealthIndicator({ theme = 'light', className = '' }: Props) {
  const session = useAuthStore((s) => s.session)
  const role = (session?.user?.app_metadata?.role as string) ?? 'cashier'
  const watching = SYNC_WATCHER_ROLES.has(role)
  const { status, severity, refresh } = useDesktopSyncHealth(watching)
  const [open, setOpen] = useState(false)

  if (!watching || !status || severity === 'clean') return null

  const stuck = severity === 'stuck'
  const palette = stuck
    ? theme === 'dark'
      ? 'bg-red-500/20 text-red-300 border-red-500/40 hover:bg-red-500/30'
      : 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100'
    : theme === 'dark'
      ? 'bg-amber-500/15 text-amber-300 border-amber-500/30 hover:bg-amber-500/25'
      : 'bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100'

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={stuck
          ? 'Частина операцій не відправилась на сервер. Натисніть, щоб переглянути'
          : 'Операції ще в черзі на відправку'}
        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors ${palette} ${className}`}
      >
        {stuck
          ? <AlertTriangle size={14} className="animate-pulse" />
          : <CloudUpload size={14} />}
        <span>{syncHealthLabel(status)}</span>
      </button>
      <SyncHealthModal
        open={open}
        // Вікно нічого не змінює — оновлюємо стан на його закритті, щоб цифри
        // на значку не відставали, поки власник у нього дивився.
        onClose={() => { setOpen(false); void refresh() }}
        status={status}
      />
    </>
  )
}
