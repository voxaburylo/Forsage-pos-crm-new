import type { AiSupplyInput } from './aiSupplyImport'
/** Parsing cannot block the cashier UI; all inputs are local until explicitly sent to AI. */
export function readAiSupplyInput(input: { text?: string; buffer?: ArrayBuffer; excel?: boolean }): Promise<AiSupplyInput> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try { worker = new Worker(new URL('./aiSupplyImport.worker.ts', import.meta.url), { type: 'module' }) }
    catch { reject(new Error('Не вдалося запустити читання таблиці. Перезапустіть програму та повторіть.')); return }
    let settled = false
    const finish = () => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null
      worker.terminate()
      return true
    }
    const fail = (message: string) => { if (finish()) reject(new Error(message)) }
    const timer = setTimeout(() => fail('Читання таблиці триває надто довго. Зменште файл та повторіть.'), 30_000)
    worker.onmessage = event => {
      const data: unknown = event.data
      if (!data || typeof data !== 'object' || Array.isArray(data)) { fail('Некоректна відповідь обробника таблиці. Повторіть читання файла.'); return }
      const response = data as {error?: unknown; result?: AiSupplyInput}
      if (response.error !== undefined) {
        fail(typeof response.error === 'string' && response.error.trim() ? response.error.slice(0,1000) : 'Не вдалося розібрати таблицю.')
        return
      }
      const result = response.result
      if (!result || typeof result.text !== 'string' || !Array.isArray(result.products) || typeof result.categoryCount !== 'number') {
        fail('Некоректна відповідь обробника таблиці. Повторіть читання файла.'); return
      }
      if (finish()) resolve(result)
    }
    worker.onerror = () => fail('Не вдалося прочитати таблицю. Перевірте файл та повторіть.')
    worker.onmessageerror = () => fail('Не вдалося отримати таблицю з обробника. Повторіть читання файла.')
    try { worker.postMessage(input, input.buffer ? [input.buffer] : []) }
    catch { fail('Не вдалося передати файл на розбір. Повторіть читання файла.') }
  })
}
