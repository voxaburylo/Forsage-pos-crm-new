import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { desktopBridge, type ExternalBackupStatus } from '@/lib/desktopBridge'
import { externalBackupReminder } from './externalBackupModel'

/** Нагадування власнику на головному екрані: флешку давно не вставляли або запис не вдався. */
export function ExternalBackupReminder() {
  const navigate = useNavigate()
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
      {text}{' '}
      <button type="button" className="font-medium underline" onClick={() => navigate('/settings?tab=network')}>Налаштування копій</button>
    </p>
  )
}
