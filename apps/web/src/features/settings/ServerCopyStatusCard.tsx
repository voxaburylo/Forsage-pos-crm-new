import { useState } from 'react'
import { CloudUpload } from 'lucide-react'
import { Button, Card } from '@/components/ui'
import { SyncHealthModal } from '@/components/SyncHealthModal'
import { useDesktopSyncHealth } from '@/hooks/useDesktopSyncHealth'
import { useAuthStore } from '@/stores/authStore'

/** Diagnostics are opt-in; the background queue never interrupts shop work. */
export function ServerCopyStatusCard() {
  const role = useAuthStore(state => state.session?.user?.app_metadata?.role)
  const allowed = role === 'owner' || role === 'admin'
  const [open, setOpen] = useState(false)
  const { status } = useDesktopSyncHealth(allowed && open)
  if (!allowed) return null
  return (
    <Card className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900"><CloudUpload size={18} />Копія для вебперегляду</h3>
          <p className="mt-1 text-xs text-gray-500">Передавання працює у фоні. Стан і помилки можна переглянути тут.</p>
        </div>
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>Переглянути стан</Button>
      </div>
      {open && <SyncHealthModal open onClose={() => setOpen(false)} status={status} />}
    </Card>
  )
}
