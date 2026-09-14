export function parseInventoryNumber(value: string): number | null {
  const normalized = value.trim().replace(',', '.')
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return null
  const number = Number(normalized)
  return Number.isFinite(number) && number >= 0 ? number : null
}

export class InventoryInputGuard {
  private failedSaves = new Map<string, { session: string; item: string }>()
  markSaveFailed(session: string, item: string, field: string): void {
    this.failedSaves.set(JSON.stringify([session, item, field]), { session, item })
  }
  markSaved(session: string, item: string, field: string): void {
    this.failedSaves.delete(JSON.stringify([session, item, field]))
  }
  failedSaveCount(session: string): number {
    return [...this.failedSaves.values()].filter(error => error.session === session).length
  }
  private errors = new Map<string, { session: string; item: string }>()
  validate(session: string, item: string, field: string, value: string): number | null {
    const key = JSON.stringify([session, item, field])
    const parsed = parseInventoryNumber(value)
    if (parsed === null) this.errors.set(key, { session, item })
    else this.errors.delete(key)
    return parsed
  }
  removeItem(session: string, item: string): void {
    for (const [key, error] of this.failedSaves) {
      if (error.session === session && error.item === item) this.failedSaves.delete(key)
    }
    for (const [key, error] of this.errors) {
      if (error.session === session && error.item === item) this.errors.delete(key)
    }
  }
  hasErrors(session: string): boolean {
    return this.failedSaveCount(session) > 0 || [...this.errors.values()].some(error => error.session === session)
  }
}
