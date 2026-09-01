import { useState } from 'react'
import { AlertTriangle, CloudUpload } from 'lucide-react'
import { SyncHealthModal } from './SyncHealthModal'
import { syncHealthLabel, useDesktopSyncHealth } from '@/hooks/useDesktopSyncHealth'

interface Props {
  /** `dark` — для темної каси, `light` — для звичайної шапки. */
  theme?: 'light' | 'dark'
  className?: string
}

/**
 * Показує, скільки локальних операцій ще не доїхало на сервер.
 *
 * Свідомо НЕ показуємо нічого, коли все синхронізовано: постійний зелений
 * значок швидко стає фоном, і тоді червоний теж перестають помічати.
 */
export function SyncHealthIndicator({ theme = 'light', className = '' }: Props) {
  const { status, severity, refresh } = useDesktopSyncHealth()
  const [open, setOpen] = useState(false)

  if (!status || severity === 'clean') return null

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
        onClose={() => setOpen(false)}
        status={status}
        onChanged={() => { void refresh() }}
      />
    </>
  )
}
