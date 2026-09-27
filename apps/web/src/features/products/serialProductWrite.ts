const pending = new Map<string, Promise<unknown>>()
/** Keep read-merge-save patches to one product ordered; unrelated products remain parallel. */
export function serialProductWrite<T>(id: string, write: () => Promise<T>): Promise<T> {
  const previous = pending.get(id) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(write).finally(() => {
    if (pending.get(id) === next) pending.delete(id)
  })
  pending.set(id, next)
  return next
}
