export interface ScanRequest { barcode?: string; product_id?: string; qty?: number; user_id?: string; operation_id?: string }

function isTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /timed?\s*out|timeout|ERR_IPC_CHANNEL_CLOSED|connection (?:closed|reset)|час очікування/i.test(message)
}

/** One logical scan, at most one transport retry; a new scan gets a new ID. */
export async function requestInventoryScan<T>(invoke: (input: ScanRequest) => Promise<T>, input: ScanRequest, supportsIds: boolean): Promise<T> {
  if (!supportsIds) return invoke(input)
  const request = { ...input, operation_id: input.operation_id ?? crypto.randomUUID() }
  try { return await invoke(request) }
  catch (error) {
    if (!isTransportFailure(error)) throw error
    return invoke(request)
  }
}
