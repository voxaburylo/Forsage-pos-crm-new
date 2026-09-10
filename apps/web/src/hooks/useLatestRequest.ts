import { useLayoutEffect, useState } from 'react'

export function createLatestRequest() {
  let generation = 0
  return {
    invalidate() { generation++ },
    begin() { const id = ++generation; return () => id === generation },
  }
}

// Invalidate at commit, before passive loading effects and before the next paint.
export function useLatestRequest(scope: unknown) {
  const [gate] = useState(createLatestRequest)
  const key = JSON.stringify(scope)
  useLayoutEffect(() => {
    gate.invalidate()
    return () => gate.invalidate()
  }, [gate, key])
  return gate
}
