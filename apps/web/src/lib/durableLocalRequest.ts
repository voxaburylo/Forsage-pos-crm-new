// Persist identity before IPC. A lost reply/restart must replay the same write.
const active = new Map<string, Promise<unknown>>()
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonical(item)]))
  return value
}
export async function durableLocalRequest<T>(scope: string, payload: unknown, send: (id: string) => Promise<T>, storage: Storage = localStorage): Promise<T> {
  const key = `forsage:pending-request:v1:${scope}`
  const fingerprint = JSON.stringify(canonical(payload))
  const runningKey = key + fingerprint
  const running = active.get(runningKey)
  if (running) return running as Promise<T>
  const read = (): Record<string, string> => {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? '{}')
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
      || Object.values(parsed).some(id => typeof id !== 'string')) throw new Error('Пошкоджений журнал незавершених операцій. Запис не розпочато.')
    return parsed as Record<string, string>
  }
  const pending = read()
  const id = pending[fingerprint] ?? crypto.randomUUID()
  pending[fingerprint] = id
  storage.setItem(key, JSON.stringify(pending))
  const task = Promise.resolve().then(() => send(id)).then(result => {
    const latest = read()
    if (latest[fingerprint] === id) delete latest[fingerprint]
    if (Object.keys(latest).length) storage.setItem(key, JSON.stringify(latest))
    else storage.removeItem(key)
    return result
  }).finally(() => { active.delete(runningKey) })
  active.set(runningKey, task)
  return task
}
