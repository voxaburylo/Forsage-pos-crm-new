import { parseSupplyText, parseSupplyWorkbook } from './aiSupplyImport'
self.onmessage = (event: MessageEvent<{ text?: string; buffer?: ArrayBuffer; excel?: boolean }>) => {
  try {
    const { text, buffer, excel } = event.data
    const result = excel && buffer ? parseSupplyWorkbook(buffer) : parseSupplyText(text ?? new TextDecoder().decode(buffer))
    self.postMessage({ result })
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'Не вдалося розібрати таблицю' }) }
}
