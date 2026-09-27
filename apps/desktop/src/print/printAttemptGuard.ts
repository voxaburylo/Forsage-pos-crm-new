import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

type Attempt = { id: string; printer: string; status: 'pending' | 'accepted' | 'failed' | 'unknown'; at: string }
export function printDefinitelyNotSent(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  if (text.includes('PRINT_SUBMISSION_STARTED')) return false
  return /PRINT_DOCUMENT_LOAD_FAILED|PRINT_(RENDER|RESOURCES)_TIMEOUT|TSPL_(NO_LABELS|BARCODE_|PRINTER_NOT_SET|QUEUE_STUCK|PRINTER_NOT_READY)|RAW_PRINT_(OPEN_FAILED|EMPTY)|PRINT_QUEUE_STUCK|PRINT_PRINTER_NOT_READY|PRINT_RECEIPT_(PRINTER_|INVALID_|PROFILE_FAILED|SIZE_INVALID|CAPTURE_SCALE)|Invalid printer settings|^PRINT_CANCELLED$/.test(text)
}

/** Keeps only printer/status metadata, never receipt HTML or customer data. */
export class PrintAttemptGuard {
  private tails = new Map<string, Promise<unknown>>()
  constructor(private file: string, private confirm: (printer: string) => Promise<boolean>, private record: (event: string, detail: unknown) => void) {}
  run<T>(printer: string, print: () => Promise<T>): Promise<T> {
    const key = printer.trim().toLocaleLowerCase('en-US') || '__default__'
    const result = (this.tails.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.execute(key, print))
    this.tails.set(key, result)
    void result.finally(() => { if (this.tails.get(key) === result) this.tails.delete(key) }).catch(() => {})
    return result
  }
  private async execute<T>(printer: string, print: () => Promise<T>): Promise<T> {
    const file = this.file + '.' + createHash('sha256').update(printer).digest('hex').slice(0, 16) + '.json'
    let state: Record<string, Attempt> = Object.create(null)
    let unreadable = false
    try { state = JSON.parse(await readFile(file, 'utf8')); if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid print state') }
    catch (error) { unreadable = (error as NodeJS.ErrnoException).code !== 'ENOENT' }
    const previous = state?.[printer]
    if (unreadable || (previous && previous.status !== 'accepted' && previous.status !== 'failed')) {
      this.record('print-repeat-confirmation', { printer, previous_id: previous?.id })
      if (!await this.confirm(printer)) throw new Error('PRINT_REPEAT_CANCELLED: Друк скасовано. Попереднє завдання потрібно перевірити в черзі принтера.')
      if (unreadable) state = Object.create(null)
    }
    const attempt: Attempt = { id: randomUUID(), printer, status: 'pending', at: new Date().toISOString() }
    const save = async () => {
      state[printer] = attempt
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file + '.tmp', JSON.stringify(state), 'utf8')
      await rename(file + '.tmp', file)
    }
    await save() // No paper is sent unless the attempt can survive an application crash.
    this.record('print-attempt-start', attempt)
    try {
      const result = await print()
      attempt.status = 'accepted' // Windows acknowledgement, NOT a physical paper sensor.
      await save()
      this.record('print-attempt-accepted', attempt)
      return result
    } catch (error) {
      attempt.status = printDefinitelyNotSent(error) ? 'failed' : 'unknown'
      await save().catch(() => {}) // The durable pending state still requires confirmation.
      this.record('print-attempt-failed', { ...attempt, error })
      throw error
    }
  }
}
