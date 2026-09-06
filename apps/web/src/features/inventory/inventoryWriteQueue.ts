/** Serializes accepted writes; a failed operation must not poison later edits.
 * No automatic retries: an uncertain response may already have committed.
 */
export class InventoryWriteQueue {
  private tail: Promise<void> = Promise.resolve()

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}
/** Event-handler wait, kept outside React render analysis. */
export async function waitForInventoryWrites(hasPending: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (hasPending()) {
    if (Date.now() >= deadline) throw new Error('Не всі зміни встигли зберегтися. Перевірте рядки та повторіть завершення ревізії.')
    await new Promise<void>(resolve => { setTimeout(resolve, 50) })
  }
}
