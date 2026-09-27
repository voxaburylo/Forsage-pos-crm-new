/** Serializes UI writes; invalidation only detaches old UI, never cancels a database write. */
export class ActionScope {
  private generation = 0
  private active = false
  get busy(): boolean { return this.active }
  invalidate(): void { this.generation++; this.active = false }
  begin(): { isCurrent: () => boolean; finish: () => void } | null {
    if (this.active) return null
    this.active = true
    const generation = ++this.generation
    const isCurrent = () => this.active && generation === this.generation
    return { isCurrent, finish: () => { if (isCurrent()) this.active = false } }
  }
}
