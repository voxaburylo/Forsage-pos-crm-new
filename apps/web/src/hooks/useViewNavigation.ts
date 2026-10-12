import { useCallback, useState, type SetStateAction } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'

// View preferences only, never a second cache of customer/product records.
const views = new Map<string, unknown>()
export function useListViewState<T>(key: string, initial: T | (() => T)) {
  const scope = useAuthStore(s => `${s.session?.user?.id ?? ''}:${s.session?.user?.app_metadata?.role ?? ''}`)
  const scopedKey = `${scope}:${key}`
  const fresh = () => typeof initial === 'function' ? (initial as () => T)() : initial
  const [stored, setStored] = useState(() => ({ key: scopedKey, value: views.has(scopedKey) ? views.get(scopedKey) as T : fresh() }))
  const value = stored.key === scopedKey ? stored.value : (views.has(scopedKey) ? views.get(scopedKey) as T : fresh())
  const setValue = useCallback((next: SetStateAction<T>) => {
    setStored(previous => {
      const current = previous.key === scopedKey ? previous.value : (views.has(scopedKey) ? views.get(scopedKey) as T : fresh())
      const updated = typeof next === 'function' ? (next as (v: T) => T)(current) : next
      views.set(scopedKey, updated)
      if (views.size > 200) views.delete(views.keys().next().value!)
      return { key: scopedKey, value: updated }
    })
  // Initial values are defaults, not a dependency that resets a working view.
  }, [scopedKey])
  return [value, setValue] as const
}

export function safeReturnTarget(state: unknown, fallback: string): { to: string; state?: unknown } {
  const target = (state as { returnView?: { to?: unknown; state?: unknown } } | null)?.returnView
  if (typeof target?.to !== 'string' || !/^\/(?!\/)/.test(target.to) || /[\\\r\n]/.test(target.to)) return { to: fallback }
  return { to: target.to, state: target.state }
}

export function useViewNavigation(fallback: string) {
  const navigate = useNavigate()
  const location = useLocation()
  const returnTarget = safeReturnTarget(location.state, fallback)
  const open = useCallback((to: string) => navigate(to, { state: {
    returnView: { to: location.pathname + location.search, state: location.state },
  } }), [navigate, location.pathname, location.search, location.state])
  const back = useCallback(() => {
    const target = safeReturnTarget(location.state, fallback)
    navigate(target.to, { state: target.state })
  }, [navigate, location.state, fallback])
  return { open, back, returnTo: returnTarget.to }
}
