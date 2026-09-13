// Persist matching decisions and operation ID atomically before IPC.
const active = new Map<string, Promise<unknown>>()
type Envelope = { id: string; body: unknown }
export async function durableImport<T>(scope: string, identity: string, body: unknown, send: (id: string, original: any) => Promise<T>, storage: Storage = localStorage): Promise<T> {
  const key = 'forsage:import-envelope:v2:' + scope
  const runningKey = key + identity
  const running = active.get(runningKey)
  if (running) return running as Promise<T>
  const read = (): Record<string, Envelope> => {
    const value = JSON.parse(storage.getItem(key) || '{}')
    if (!value || Array.isArray(value) || typeof value !== 'object'
      || Object.values(value).some((entry: any) => !entry || typeof entry.id !== 'string' || !('body' in entry)))
      throw new Error('Пошкоджений журнал імпорту. Запис не розпочато.')
    return value
  }
  const pending = read()
  const entry = pending[identity] ?? { id: crypto.randomUUID(), body }
  pending[identity] = entry
  storage.setItem(key, JSON.stringify(pending))
  const task = Promise.resolve().then(() => send(entry.id, entry.body)).then(result => {
    const latest = read()
    if (latest[identity]?.id === entry.id) delete latest[identity]
    if (Object.keys(latest).length) storage.setItem(key, JSON.stringify(latest))
    else storage.removeItem(key)
    return result
  }).finally(() => active.delete(runningKey))
  active.set(runningKey, task)
  return task
}
