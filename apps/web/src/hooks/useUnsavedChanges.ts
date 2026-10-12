import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { useBeforeUnload, useBlocker } from 'react-router-dom'

const drafts = new Map<symbol, { dirty: boolean; busy: boolean; allowed: boolean }>()
const listeners = new Set<() => void>()
let revision = 0
function publish() { revision++; listeners.forEach(listener => listener()) }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => revision

function hasUnsavedChanges() {
  return [...drafts.values()].some(draft => !draft.allowed && (draft.dirty || draft.busy))
}

/** Check BEFORE a destructive lifecycle action (such as revoking the session). */
export function confirmUnsavedDeparture(): boolean {
  if ([...drafts.values()].some(draft => !draft.allowed && draft.busy)) {
    window.alert('Дочекайтеся завершення збереження.')
    return false
  }
  return !hasUnsavedChanges() || window.confirm('Вийти без збереження введених змін?')
}

/** One router blocker aggregates all forms, including contextual modal editors. */
export function NavigationGuard() {
  useSyncExternalStore(subscribe, snapshot, snapshot)
  const pending = useRef(false)
  const nativeUnloadPermission = useRef<{ revision: number; expiresAt: number } | null>(null)
  const blocked = hasUnsavedChanges
  const busy = [...drafts.values()].some(draft => !draft.allowed && draft.busy)
  const blocker = useBlocker(({ currentLocation, nextLocation }) => blocked()
    && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search))
  useBeforeUnload(useCallback((event: BeforeUnloadEvent) => {
    // Main asks outside beforeunload, while Electron can still display the
    // confirmation. Permit only the immediately following unload of this state.
    const permission = nativeUnloadPermission.current
    const approved = permission?.revision === revision && performance.now() <= permission.expiresAt
    nativeUnloadPermission.current = null
    if (hasUnsavedChanges() && !approved) { event.preventDefault(); event.returnValue = '' }
  }, []))
  useEffect(() => {
    const requestUnload = (event: Event) => {
      const detail = (event as CustomEvent<{ handled: boolean; approved: boolean; deadline: number }>).detail
      if (!detail || typeof detail !== 'object') return
      detail.handled = true
      nativeUnloadPermission.current = null
      detail.approved = false
      if (!Number.isFinite(detail.deadline) || Date.now() >= detail.deadline) return
      const requestedRevision = revision
      const confirmed = confirmUnsavedDeparture()
      // A prompt can remain open beyond main's deadline. Never leave an unload
      // permit behind after main has already abandoned that close attempt.
      const remaining = detail.deadline - Date.now()
      detail.approved = confirmed && remaining > 0 && requestedRevision === revision
      if (detail.approved) nativeUnloadPermission.current = { revision, expiresAt: performance.now() + Math.min(1000, remaining) }
    }
    // dirty may remain true across edits, so revision alone is insufficient.
    const revokePermission = () => { nativeUnloadPermission.current = null }
    window.addEventListener('forsage:request-unload', requestUnload)
    window.addEventListener('input', revokePermission, true)
    window.addEventListener('change', revokePermission, true)
    return () => {
      window.removeEventListener('forsage:request-unload', requestUnload)
      window.removeEventListener('input', revokePermission, true)
      window.removeEventListener('change', revokePermission, true)
      nativeUnloadPermission.current = null
    }
  }, [])
  useEffect(() => {
    if (blocker.state !== 'blocked') { pending.current = false; return }
    if (pending.current) return
    pending.current = true
    if (busy) {
      window.alert('Дочекайтеся завершення збереження.')
      blocker.reset()
    } else if (window.confirm('Вийти без збереження введених змін?')) {
      // Approval covers this one departure, not future edits on the destination.
      blocker.proceed()
    } else blocker.reset()
  }, [blocker, busy])
  return null
}

export function useUnsavedChanges(dirty: boolean, busy = false) {
  const token = useRef(Symbol('draft'))
  useLayoutEffect(() => {
    const key = token.current
    drafts.set(key, { dirty, busy, allowed: false })
    publish()
  }, [dirty, busy])
  useEffect(() => {
    const key = token.current
    return () => { drafts.delete(key); publish() }
  }, [])
  const allowLeave = useCallback(() => {
    const draft = drafts.get(token.current)
    if (draft) { draft.allowed = true; publish() }
  }, [])
  return { allowLeave }
}
