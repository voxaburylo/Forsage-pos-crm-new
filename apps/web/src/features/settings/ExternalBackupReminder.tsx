import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { desktopBridge, type ExternalBackupStatus } from '@/lib/desktopBridge'
import { externalBackupReminder } from './externalBackupModel'

/** Нагадування власнику на головному екрані: флешку давно не вставляли або запис не вдався. */
export function ExternalBackupReminder() {
  const [status, setStatus] = useState<ExternalBackupStatus | null>(null)
  useEffect(() => {
    const bridge = desktopBridge()?.externalBackup
    if (!bridge) return
    bridge.status().then(setStatus).catch(() => setStatus(null))
  }, [])
  const text = externalBackupReminder(status)
  if (!text) return null
  return (
    <p role="alert" className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
      {text} <Link to="/settings" className="font-medium underline">Налаштування копій</Link>
    </p>
  )
}
