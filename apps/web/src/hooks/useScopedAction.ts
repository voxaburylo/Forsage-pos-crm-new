import { useLayoutEffect, useRef, useState } from 'react'
import { ActionScope } from '@/lib/actionScope'

export function useScopedAction(scopeKey: string) {
  const scope = useRef(new ActionScope())
  const mounted = useRef(false)
  const [busy, setBusy] = useState(false)
  useLayoutEffect(() => {
    scope.current.invalidate()
    mounted.current = true
    setBusy(false)
    return () => { mounted.current = false; scope.current.invalidate() }
  }, [scopeKey])
  function begin() {
    if (!mounted.current) return null
    const attempt = scope.current.begin()
    if (!attempt) return null
    setBusy(true)
    return {
      isCurrent: attempt.isCurrent,
      finish() {
        if (attempt.isCurrent()) setBusy(false)
        attempt.finish()
      },
    }
  }
  return { busy, begin, isBusy: () => scope.current.busy }
}
