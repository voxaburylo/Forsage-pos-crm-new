/**
 * Serializes Windows print jobs per physical printer. Jobs for POS-58 and
 * POS-80 remain independent, while two jobs addressed to the same device can
 * never race each other in the Windows spooler guards.
 */
const printerTails = new Map<string, Promise<void>>()
type JobGuard = <T>(printer: string, job: () => Promise<T>) => Promise<T>
let jobGuard: JobGuard = (_printer, job) => job()
export function setPrinterJobGuard(guard: JobGuard): void { jobGuard = guard }

function printerKey(printerName: string): string {
  return printerName.trim().toLocaleLowerCase('en-US') || '__windows_default_printer__'
}

export function enqueuePrinterJob<T>(printerName: string, job: () => Promise<T>): Promise<T> {
  const key = printerKey(printerName)
  const previous = printerTails.get(key) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(() => jobGuard(printerName, job))
  const tail = run.then(() => undefined, () => undefined)
  printerTails.set(key, tail)

  void tail.finally(() => {
    if (printerTails.get(key) === tail) printerTails.delete(key)
  })
  return run
}
