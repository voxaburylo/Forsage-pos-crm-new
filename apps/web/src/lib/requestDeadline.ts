export async function withRequestDeadline<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number, caller?: AbortSignal | null): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort(caller?.reason)
  let timedOut = false
  const stopped = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error(timedOut
      ? 'Сервер не відповів вчасно. Перевірте результат операції перед повторенням.' : 'Запит скасовано.')), { once: true })
  })
  caller?.addEventListener('abort', abort, { once: true })
  if (caller?.aborted) abort()
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, Math.max(1000, timeoutMs))
  try {
    return await Promise.race([stopped, Promise.resolve().then(() => {
      controller.signal.throwIfAborted()
      return work(controller.signal)
    })])
  } finally { clearTimeout(timer); caller?.removeEventListener('abort', abort) }
}
