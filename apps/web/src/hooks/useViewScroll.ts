import { useLayoutEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'

const positions = new Map<string, number>()

/** Restore after asynchronous rows load; a deliberate user scroll always wins. */
export function useViewScroll() {
  const ref = useRef<HTMLElement>(null)
  const location = useLocation()
  const scope = useAuthStore(s => `${s.session?.user?.id ?? ''}:${s.session?.user?.app_metadata?.role ?? ''}`)
  const key = `${scope}:${location.pathname}${location.search}`
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const target = positions.get(key) ?? 0
    if (target === 0) node.scrollTop = 0
    let restoring = target > 0
    let frame = 0
    let stopped = false
    const save = () => { if (!restoring) positions.set(key, node.scrollTop) }
    const stop = () => { restoring = false; cancelAnimationFrame(frame) }
    const restore = () => {
      if (stopped || !restoring) return
      if (node.scrollHeight - node.clientHeight >= target) {
        node.scrollTop = target
        restoring = false
      } else frame = requestAnimationFrame(restore)
    }
    node.addEventListener('scroll', save)
    node.addEventListener('wheel', stop, { passive: true })
    node.addEventListener('touchstart', stop, { passive: true })
    node.addEventListener('pointerdown', stop)
    if (restoring) frame = requestAnimationFrame(restore)
    const timeout = window.setTimeout(stop, 15_000)
    return () => {
      stopped = true
      save()
      cancelAnimationFrame(frame)
      clearTimeout(timeout)
      node.removeEventListener('scroll', save)
      node.removeEventListener('wheel', stop)
      node.removeEventListener('touchstart', stop)
      node.removeEventListener('pointerdown', stop)
      if (positions.size > 200) positions.delete(positions.keys().next().value!)
    }
  }, [key])
  return ref
}
