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
