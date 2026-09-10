import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { desktopBridge } from '@/lib/desktopBridge'
import LoginPage from '@/pages/LoginPage'

// Keep the underlying draft mounted. Main-process IPC is also blocked while locked.
export function DesktopAccessGate() {
  const [locked, setLocked] = useState(false)
  const location = useLocation()
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
    let active = true
    const check = () => { void status().then(s => { if (active) setLocked(s.locked) }).catch(() => { if (active) setLocked(true) }) }
    check()
    const timer = window.setInterval(check, 5000)
    window.addEventListener('focus',check)
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus',check) }
  }, [])
  if (!locked || location.pathname === '/login') return null
  return <div className="fixed inset-0 z-[1000] overflow-auto bg-gray-100" role="dialog" aria-modal="true" aria-label="Програму заблоковано">
    <LoginPage onUnlocked={() => setLocked(false)} />
  </div>
}
