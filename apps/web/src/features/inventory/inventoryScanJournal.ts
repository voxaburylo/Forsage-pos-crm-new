import type { ScanRequest } from './inventoryScanRequest'

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export class InventoryScanJournal {
  constructor(private readonly storage: Store) {}
  private key(sessionId: string) { return `forsage:inventory-scans:v1:${sessionId}` }
  list(sessionId: string): ScanRequest[] {
    const raw = this.storage.getItem(this.key(sessionId))
    if (raw === null) return []
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value) || value.some(row => !row || typeof row.operation_id !== 'string' || (!row.barcode && !row.product_id) || !Number.isInteger(row.qty) || row.qty <= 0)) {
      throw new Error('Журнал незавершених сканувань пошкоджено. Не завершуйте ревізію до перевірки.')
    }
    return value as ScanRequest[]
  }
  add(sessionId: string, input: ScanRequest): ScanRequest {
    const rows = this.list(sessionId)
    const request = { ...input, qty: input.qty ?? 1, operation_id: input.operation_id ?? crypto.randomUUID() }
    const existing = rows.find(row => row.operation_id === request.operation_id)
    if (existing) {
      if (existing.barcode !== request.barcode || existing.product_id !== request.product_id || existing.qty !== request.qty) throw new Error('Дані повторного сканування змінилися')
      return existing
    }
    if (rows.length >= 1000) throw new Error('Черга сканувань заповнена. Відновіть незавершені сканування.')
    this.storage.setItem(this.key(sessionId), JSON.stringify([...rows, request]))
    return request
  }
  acknowledge(sessionId: string, operationId: string): void {
    const rows = this.list(sessionId).filter(row => row.operation_id !== operationId)
    if (rows.length) this.storage.setItem(this.key(sessionId), JSON.stringify(rows))
    else this.storage.removeItem(this.key(sessionId))
  }
  clear(sessionId: string): void { this.storage.removeItem(this.key(sessionId)) }
}
