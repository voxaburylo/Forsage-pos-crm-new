import type { DesktopRuntimeInfo } from '@/lib/desktopBridge'

export function BuildInfoSummary({ build }: { build: DesktopRuntimeInfo['build'] }) {
  if (!build) return <p className="mt-2 text-xs text-gray-600">Номер збірки недоступний у цій версії.</p>
  const date = new Date(build.builtAt)
  return <div className="mt-2 text-xs text-emerald-900" aria-label="Версія програми">
    <p>Збірка: <span className="font-mono break-all">{build.releaseId}</span></p>
    <p>Створено: {Number.isFinite(date.getTime()) ? date.toLocaleString('uk-UA') : 'невідомо'}</p>
  </div>
}
