import { api } from '@/lib/api'
import { desktopBridge, type DesktopBootstrapImportResult, type DesktopBootstrapSnapshot } from '@/lib/desktopBridge'

export async function fetchBootstrapSnapshot(): Promise<DesktopBootstrapSnapshot> {
  const response = await api.get<{ data: DesktopBootstrapSnapshot }>('/api/v1/sync/bootstrap', {
    silent: true,
    timeoutMs: 180_000,
  })
  return response.data
}

export async function importBootstrapSnapshotToDesktop(
  snapshot: DesktopBootstrapSnapshot,
): Promise<DesktopBootstrapImportResult> {
  const desktop = desktopBridge()
  if (!desktop) throw new Error('Desktop runtime недоступний')
  return desktop.bootstrap.importSnapshot(snapshot)
}

export async function bootstrapDesktopFromServer(): Promise<DesktopBootstrapImportResult> {
  const snapshot = await fetchBootstrapSnapshot()
  return importBootstrapSnapshotToDesktop(snapshot)
}
