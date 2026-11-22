import { useEffect, useState } from 'react'
import { desktopBridge, isDesktopRuntime } from '@/lib/desktopBridge'
import { buildLabel, type BuildLabel } from './buildLabel'

/** Номер збірки під назвою програми — у меню й на сторінці входу (див. buildLabel). */
export function BuildBadge({ className = '' }: { className?: string }) {
  const [label, setLabel] = useState<BuildLabel | null>(() => isDesktopRuntime()
    ? null
    : buildLabel({ desktop: false, webBuiltAt: typeof __WEB_BUILT_AT__ === 'string' ? __WEB_BUILT_AT__ : null, webCommit: typeof __WEB_COMMIT__ === 'string' ? __WEB_COMMIT__ : null }))
  useEffect(() => {
    if (!isDesktopRuntime()) return
    let stopped = false
    const load = () => desktopBridge()?.getRuntimeInfo().then(info => {
      if (!stopped) setLabel(buildLabel({ desktop: true, build: info.build, stagedUpdateReleaseId: info.stagedUpdateReleaseId, managerPc: info.lan?.mode === 'client' }))
    }).catch(() => undefined)
    void load()
    // ПК менеджера завантажує оновлення у фоні — підпис «оновлення готове» має з'явитись без перезапуску.
    const timer = window.setInterval(() => { void load() }, 5 * 60_000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [])
  if (!label) return null
  return (
    <div className={`text-[11px] leading-tight text-gray-400 ${className}`} title={label.title} data-build-label>
      {label.text}
      {label.updateWaiting && <span className="ml-1 text-amber-600">· оновлення встановиться при закритті</span>}
    </div>
  )
}
