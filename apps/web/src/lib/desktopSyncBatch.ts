import type { DesktopSyncOutboxOperation, DesktopSyncPushResult } from './desktopBridge'

// Below Express's 4 MiB parser and the hosting request limit. Count UTF-8
// bytes, not JS characters: Ukrainian names and signed snapshots also travel.
export const DESKTOP_PUSH_MAX_BYTES = 3.5 * 1024 * 1024
const encoder = new TextEncoder()

export function selectDesktopPushBatch(
  operations: DesktopSyncOutboxOperation[],
  resetGeneration: number,
  maxBytes = DESKTOP_PUSH_MAX_BYTES,
): { operations: DesktopSyncOutboxOperation[]; oversized: DesktopSyncOutboxOperation | null } {
  let bytes = encoder.encode(JSON.stringify({ reset_generation: resetGeneration, operations: [] })).byteLength
  const selected: DesktopSyncOutboxOperation[] = []
  for (const operation of operations) {
    const size = encoder.encode(JSON.stringify(operation)).byteLength + (selected.length ? 1 : 0)
    if (bytes + size > maxBytes) {
      // Never skip ahead: later operations can depend on it. The repository
      // applies dependency barriers on the next selection after a failure.
      return { operations: selected, oversized: selected.length ? null : operation }
    }
    selected.push(operation)
    bytes += size
  }
  return { operations: selected, oversized: null }
}

export function validateDesktopPushResults(
  operations: DesktopSyncOutboxOperation[],
  response: unknown,
): DesktopSyncPushResult[] {
  if (!Array.isArray(response)) throw new Error('Сервер не підтвердив отримання документів')
  const expected = new Map(operations.map((operation) => [operation.sequence, operation.operation_id]))
  const received = new Map<number, DesktopSyncPushResult>()
  for (const result of response as DesktopSyncPushResult[]) {
    if (!result || !expected.has(result.sequence) || expected.get(result.sequence) !== result.operation_id
      || received.has(result.sequence) || !['synced', 'failed', 'discarded'].includes(result.status)) {
      throw new Error('Некоректне підтвердження синхронізації. Документи залишено для повторної передачі')
    }
    received.set(result.sequence, result)
  }
  // Preserve valid acknowledgements, but retry missing ones with backoff.
  return operations.map((operation) => received.get(operation.sequence) ?? {
    sequence: operation.sequence,
    operation_id: operation.operation_id,
    status: 'failed',
    error: 'Сервер не підтвердив цей документ. Передачу буде повторено',
  })
}
