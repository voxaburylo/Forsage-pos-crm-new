import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isLanProxyChannel } from '../src/lan/localNetwork'
import { webRpcChannelAllowed } from '../src/lan/webRpcChannels'
import { PUBLIC_DESKTOP_CHANNELS } from '../src/security/desktopAuthorization'

// 23.11.2026: власник звіряє версії двох ПК. Номер збірки має бути видно й на екрані входу,
// а канал «усе про цей ПК» (desktop:get-runtime-info) і далі вимагає входу.
describe('the build number is readable before sign-in', () => {
  const channel = 'desktop:get-runtime-info-build'
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8').split(String.fromCharCode(13)).join('')

  it('is public, while the full runtime info still needs a session', () => {
    expect(PUBLIC_DESKTOP_CHANNELS.has(channel)).toBe(true)
    expect(PUBLIC_DESKTOP_CHANNELS.has('desktop:get-runtime-info')).toBe(false)
  })

  it('describes this computer only: never proxied to the main PC or callable from the web', () => {
    expect(isLanProxyChannel(channel)).toBe(false)
    expect(webRpcChannelAllowed(channel)).toBe(false)
  })

  it('returns the build and the PC mode, nothing from the shop database', () => {
    const main = read('../src/main.ts')
    const start = main.indexOf("handleDesktopIpc('desktop:get-runtime-info-build'")
    expect(start).toBeGreaterThan(0)
    const handler = main.slice(start, main.indexOf('\n\n', start))
    expect(handler).toContain('build: desktopBuildInfo')
    expect(handler).toContain('stagedUpdateReleaseId')
    expect(handler).not.toContain('requireLocalDatabase')
    expect(read('../src/desktopApi.ts')).toContain("getBuildInfo: () => ipcRenderer.invoke('desktop:get-runtime-info-build')")
  })

  it('the label prefers it and still works with an older program', () => {
    const badge = read('../../web/src/components/BuildBadge.tsx')
    expect(badge).toContain('bridge?.getBuildInfo ? bridge.getBuildInfo() : bridge?.getRuntimeInfo?.()')
  })
})
