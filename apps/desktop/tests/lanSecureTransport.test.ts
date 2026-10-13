import { expect, it, vi } from 'vitest'
import { LanReplayGuard, lanRequestContext, openLanEnvelope, sealLanEnvelope, secureNonce, SECURE_MAX_BYTES } from '../src/lan/secureTransport'

const code = '1234567890abcdef1234567890abcdef'
it.each([-7, 7])('uses the hub clock when the manager PC is skewed by %s days', days => {
  const hubNow = 1_800_000_000_000, hubNonce = secureNonce()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(hubNow + days * 86_400_000)
  try {
    const context = lanRequestContext(hubNonce, hubNow)
    expect(context.deadline).toBe(hubNow + 30000)
    const request = sealLanEnvelope({ action: 'login' }, code, 'request', context)
    expect(openLanEnvelope(request, code, 'request', { hubNonce }, hubNow).value).toEqual({ action: 'login' })
    expect(() => openLanEnvelope(request, code, 'request', { hubNonce }, hubNow + 30001)).toThrow()
    expect(() => openLanEnvelope(sealLanEnvelope({}, code, 'request', lanRequestContext(hubNonce, hubNow + 7 * 86_400_000)), code, 'request', { hubNonce }, hubNow)).toThrow()
    expect(() => lanRequestContext(hubNonce, -1)).toThrow()
    expect(() => lanRequestContext(hubNonce, Number.MAX_SAFE_INTEGER)).toThrow()
    expect(() => lanRequestContext(hubNonce, '1800000000000')).toThrow()
  } finally { clock.mockRestore() }
})
it('authenticates every field, direction, key and request binding before accepting plaintext', () => {
  const context = { hubNonce: secureNonce(), requestId: secureNonce(), deadline: 10000 }
  const request = sealLanEnvelope({ phone: '0671234567', password: 'private' }, code, 'request', context)
  expect(openLanEnvelope(request, code, 'request', context, 0).value).toEqual({ phone: '0671234567', password: 'private' })
  for (const changed of [{ ...request, tag: Buffer.alloc(16).toString('base64') }, { ...request, data: request.data.slice(4) }, { ...request, deadline: 10001 }, { ...request, requestId: secureNonce() }, { ...request, hubNonce: secureNonce() }, { ...request, iv: Buffer.alloc(12).toString('base64') }, { ...request, version: 2 }]) {
    expect(() => openLanEnvelope(changed, code, 'request', context, 0)).toThrow()
  }
  expect(() => openLanEnvelope(request, 'f'.repeat(32), 'request', context, 0)).toThrow()
  expect(() => openLanEnvelope(request, code, 'response', context, 0)).toThrow()
  expect(() => openLanEnvelope(request, code, 'request', { ...context, requestId: secureNonce() }, 0)).toThrow()
  expect(() => openLanEnvelope(request, code, 'request', context, 10001)).toThrow()
  expect(() => openLanEnvelope(request, code, 'request', context, -100000)).toThrow()
  expect(() => sealLanEnvelope('x'.repeat(SECURE_MAX_BYTES), code, 'request', context)).toThrow('LAN_SECURE_TOO_LARGE')
})
it('uses independent unpredictable IVs and response encryption and bounded fail-closed replay memory', () => {
  const context = { hubNonce: secureNonce(), requestId: secureNonce(), deadline: 10000 }
  const a = sealLanEnvelope({ ok: true }, code, 'response', context)
  const b = sealLanEnvelope({ ok: true }, code, 'response', context)
  expect(a.iv).not.toBe(b.iv); expect(a.data).not.toBe(b.data)
  const guard = new LanReplayGuard(1)
  guard.claim(a.requestId, a.deadline, 0)
  expect(() => guard.claim(a.requestId, a.deadline, 0)).toThrow('LAN_REPLAY_REJECTED')
  expect(() => guard.claim(secureNonce(), 12000, 0)).toThrow('LAN_REPLAY_REJECTED')
  expect(() => guard.claim(secureNonce(), 20000, 10001)).not.toThrow()
})
