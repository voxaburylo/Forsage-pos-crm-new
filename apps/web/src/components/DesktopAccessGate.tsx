import { setDesktopAccessLocked, desktopUnlockRevision, DESKTOP_UNLOCK_EVENT } from '@/lib/desktopAccessState'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { desktopBridge } from '@/lib/desktopBridge'
import LoginPage from '@/pages/LoginPage'
import { createReadPoller } from '@/lib/readPoller'

// Keep the underlying draft mounted. Main-process IPC is also blocked while locked.
export function DesktopAccessGate() {
  const [locked, setLocked] = useState(false)
  const location = useLocation()
  const updateLocked = (value: boolean) => { setDesktopAccessLocked(value); setLocked(value) }
  useEffect(() => {
    const workspace = document.getElementById('desktop-workspace')
    if (locked && location.pathname !== '/login') {
      workspace?.setAttribute('inert','')
      if (document.activeElement instanceof HTMLElement && workspace?.contains(document.activeElement)) document.activeElement.blur()
    } else workspace?.removeAttribute('inert')
    return () => workspace?.removeAttribute('inert')
  }, [locked, location.pathname])
  useEffect(() => {
    const status = desktopBridge()?.auth?.rememberedStatus
    if (!status) return
    // Security checks continue in hidden windows, but never overlap a slow IPC reply.
    const poller = createReadPoller({
      read: async () => {
        const revision = desktopUnlockRevision()
        try { return { revision, locked: (await status()).locked } }
        catch { return { revision, locked: true } }
      },
      onData: result => {
        // A reply started before successful login must not lock the new session.
        if (result.revision === desktopUnlockRevision()) updateLocked(result.locked)
      },
      intervalMs: 5000,
    })
    const unlocked = () => { updateLocked(false); poller.wake() }
    poller.wake()
    window.addEventListener('focus', poller.wake)
    window.addEventListener(DESKTOP_UNLOCK_EVENT, unlocked)
    return () => { poller.stop(); window.removeEventListener('focus', poller.wake); window.removeEventListener(DESKTOP_UNLOCK_EVENT, unlocked) }
  }, [])
  if (!locked || location.pathname === '/login') return null
  return <div className="fixed inset-0 z-[1000] overflow-auto bg-gray-100" role="dialog" aria-modal="true" aria-label="Програму заблоковано">
    <LoginPage onUnlocked={() => updateLocked(false)} />
  </div>
}
