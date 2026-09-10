export function aiChatStorageKey(userId: string, tenantId: string, invoiceOnly: boolean): string {
  return `forsage:ai-chat:v2:${encodeURIComponent(tenantId)}:${encodeURIComponent(userId)}:${invoiceOnly ? 'invoice' : 'assistant'}`
}

export function saveAiChat(key: string, storage: Storage, value: Record<string, unknown>): void {
  // Persist the action identifier before sending a write: a crash/reload must
  // replay the same SQLite operation, not create a second invoice.
  storage.setItem(key, JSON.stringify({ ...value, savedAt: Date.now() }))
}

export function readAiChat(key: string, storage: Storage): Record<string, any> {
  try {
    const saved = JSON.parse(storage.getItem(key) ?? '{}')
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
    const entries = Array.isArray(saved.entries) ? saved.entries.filter((entry: any) => entry && ['user', 'model'].includes(entry.role) && typeof entry.text === 'string') : []
    const object = (value: any) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    return { entries: entries.slice(-80), applied: object(saved.applied), applyMsg: object(saved.applyMsg), applyStatus: object(saved.applyStatus), applyErrors: object(saved.applyErrors) }
  } catch { return {} }
}
