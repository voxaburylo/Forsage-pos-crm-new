export async function withPrintTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  errorCode: string,
  onTimeout?: () => void,
): Promise<T> {
  let timeout: NodeJS.Timeout | null = null
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      // Queue the stable stage error before cancellation rejects the underlying
      // Electron/PowerShell operation with a less useful generic abort code.
      reject(new Error(errorCode))
      try { onTimeout?.() } catch { /* best-effort cancellation */ }
    }, timeoutMs)
  })

  try {
    return await Promise.race([operation, timeoutPromise])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

