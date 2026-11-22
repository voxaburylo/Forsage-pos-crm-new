import { contextBridge, ipcRenderer as electronIpcRenderer } from 'electron'
import { localizeDesktopIpcError } from './ipcError'
import { createDesktopApi } from './desktopApi'

// No DOM text, form values, arguments, clipboard or screenshots are collected.
let diagnosticWindowAt = 0, diagnosticCount = 0
function reportDiagnostic(payload: Record<string, unknown>): void {
  if (Date.now() - diagnosticWindowAt > 1000) { diagnosticWindowAt = Date.now(); diagnosticCount = 0 }
  if (++diagnosticCount > 20) return
  try { electronIpcRenderer.send('desktop:diagnostic-event', payload) } catch { /* diagnostics must not break the UI */ }
}
const reportSection = () => reportDiagnostic({ kind: 'section', section: window.location.hash.slice(0, 200) })
window.addEventListener('DOMContentLoaded', reportSection)
window.addEventListener('hashchange', reportSection)

const ipcRenderer = {
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    try {
      return await electronIpcRenderer.invoke(channel, ...args)
    } catch (error) {
      throw localizeDesktopIpcError(error)
    }
  },
}

let audioUnavailable = false
const audioFailureListeners = new Set<() => void>()
electronIpcRenderer.on('desktop:audio-unavailable', () => {
  audioUnavailable = true
  for (const listener of audioFailureListeners) {
    try { listener() } catch { /* optional audio must never affect IPC */ }
  }
})

contextBridge.exposeInMainWorld('forsageDesktop', {
  diagnostics: {
    onAudioUnavailable: (listener: () => void) => {
      if (typeof listener !== 'function') return () => {}
      audioFailureListeners.add(listener)
      if (audioUnavailable) listener()
      return () => { audioFailureListeners.delete(listener) }
    },
    reportError: (kind: string, message: string, stack: string) => {
      if (kind !== 'renderer-error' && kind !== 'renderer-rejection') return
      reportDiagnostic({ kind, message: String(message).slice(0, 2048), stack: String(stack).slice(0, 4096) })
    },
  },
  ...createDesktopApi(ipcRenderer),
  /** Повернути клавіатуру в поля після системного вікна confirm/alert (нічого не передає, лише сигнал). */
  restoreInputFocus: () => { try { electronIpcRenderer.send('desktop:window:restore-input-focus') } catch { /* не критично */ } },
})
