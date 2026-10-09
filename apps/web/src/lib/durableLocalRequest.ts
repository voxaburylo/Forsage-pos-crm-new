// Persist identity before IPC. A lost reply/restart must replay the same write.
const active = new Map<string, Promise<unknown>>()
function canonical(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Некоректна кількість або сума. Запис не виконано.')
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonical(item)]))
  return value
}
export function localRequestFingerprint(payload: unknown): string { return JSON.stringify(canonical(payload)) }

function readPending(scope: string, storage: Storage): Record<string, string> {
  const parsed: unknown = JSON.parse(storage.getItem('forsage:pending-request:v1:' + scope) ?? '{}')
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
    || Object.values(parsed).some(id => typeof id !== 'string' || !id.trim() || id.length > 200))
    throw new Error('Пошкоджений журнал незавершених операцій. Запис не розпочато.')
  return parsed as Record<string, string>
}

export function pendingLocalRequests(scope: string, storage: Storage = localStorage) {
  return Object.entries(readPending(scope, storage)).map(([fingerprint, operationId]) => {
    const payload: unknown = JSON.parse(fingerprint)
    return { operationId, payload }
  })
}

export function clearPendingLocalRequest(scope: string, operationId: string, storage: Storage = localStorage) {
  const pending = readPending(scope, storage)
  for (const [fingerprint, id] of Object.entries(pending)) if (id === operationId) delete pending[fingerprint]
  const key = 'forsage:pending-request:v1:' + scope
  if (Object.keys(pending).length) storage.setItem(key, JSON.stringify(pending))
  else storage.removeItem(key)
}

export async function durableLocalRequest<T>(scope: string, payload: unknown, send: (id: string) => Promise<T>, storage: Storage = localStorage, options: { exclusive?: boolean } = {}): Promise<T> {
  const key = `forsage:pending-request:v1:${scope}`
  const fingerprint = localRequestFingerprint(payload)
  const runningKey = key + fingerprint
  const running = active.get(runningKey)
  if (running) return running as Promise<T>
  const read = () => readPending(scope, storage)
  const pending = read()
  if (options.exclusive && Object.keys(pending).some(key => key !== fingerprint))
    throw new Error('Є складська операція без підтвердження. Спочатку перевірте попередню спробу.')
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
