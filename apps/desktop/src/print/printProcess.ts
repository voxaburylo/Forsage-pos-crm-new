import type { ChildProcessWithoutNullStreams } from 'node:child_process'

interface PrintProcessOptions {
  successMarker: string
  failureCode: string
  timeoutCode: string
  timeoutMs: number
  signal?: AbortSignal
  abortCode?: string
  printer?: string
  documentName?: string
}
let report: (event: string, detail: unknown) => void = () => {}
export function setPrintProcessReporter(reporter: typeof report): void { report = reporter }

// A helper may reject the job before reading stdin. Wait for close/stderr so
// write EOF/EPIPE does not replace the useful printer error. Never resubmit.
export function waitForPrintProcess(child: ChildProcessWithoutNullStreams, input: string, options: PrintProcessOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', inputError: Error | undefined, settled = false
    let submitting = false
    const stages = new Set<string>()
    let timer: NodeJS.Timeout | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (error && submitting) error.message += ' [PRINT_SUBMISSION_STARTED]'
      report(error ? 'print-helper-failed' : 'print-helper-accepted', { printer: options.printer, document: options.documentName, submitting, error })
      if (error) reject(error); else resolve()
    }
    const stop = () => { try { child.kill() } catch { /* already stopped */ } }
    const abort = () => { stop(); finish(new Error(options.abortCode || options.timeoutCode)) }
    child.stdout.on('data', chunk => {
      stdout = (stdout + String(chunk)).slice(-16384)
      for (const match of stdout.matchAll(/FORSAGE_PRINT_STAGE:(submission-started|job-created:\d+|submitted)\r?\n/g)) {
        if (stages.has(match[1])) continue
        stages.add(match[1]); submitting = true
        report('print-helper-stage', { printer: options.printer, document: options.documentName, stage: match[1] })
      }
    })
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16384) })
    child.on('error', finish)
    child.stdin.on('error', error => { inputError = error })
    child.on('close', code => {
      if (code === 0 && !inputError && stdout.includes(options.successMarker)) finish()
      else {
        const detail = stderr.trim() || (stdout.includes(options.successMarker) ? '' : stdout.trim())
        finish(new Error(detail || (options.failureCode + (inputError ? ': ' + inputError.message : ' (exit ' + code + ')'))))
      }
    })
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) { abort(); return }
    timer = setTimeout(() => { stop(); finish(new Error(options.timeoutCode)) }, options.timeoutMs)
    try { child.stdin.end(input) } catch (error) {
      inputError = error instanceof Error ? error : new Error(String(error))
    }
  })
}
