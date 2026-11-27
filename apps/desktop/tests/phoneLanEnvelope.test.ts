import { describe, expect, it } from 'vitest'
import { lanRequestContext, openLanEnvelope, sealLanEnvelope, secureNonce } from '../src/lan/secureTransport'
import { newRequestId, openEnvelope, sealEnvelope } from '../../web/src/lib/phoneLan/envelope'

// 27.11.2026: телефон шифрує вбудованою криптографією браузера, головний ПК — криптографією Node. Конверти мають
// відкриватися в обидва боки, інакше телефон через Wi-Fi не зможе працювати. Дані з літерою «s».
describe('phone (WebCrypto) and main PC (Node) open each other\'s envelopes', () => {
  const code = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
  it('a phone request opens on the main PC, and its answer opens on the phone', async () => {
    const hubNonce = secureNonce()
    const context = { ...lanRequestContext(hubNonce, Date.now()), requestId: newRequestId() }
    const request = await sealEnvelope({ action: 'phone-login', phone: '', password: 's3cret-s' }, code, 'request', context)
    const opened = openLanEnvelope(JSON.parse(JSON.stringify(request)), code, 'request', { hubNonce })
    expect(opened.value).toEqual({ action: 'phone-login', phone: '', password: 's3cret-s' })
    const reply = sealLanEnvelope({ ok: true, result: { token: 'ss' } }, code, 'response', opened.envelope)
    await expect(openEnvelope(JSON.parse(JSON.stringify(reply)), code, 'response', context)).resolves.toEqual({ ok: true, result: { token: 'ss' } })
  })
  it('a wrong code or another request\'s answer is rejected', async () => {
    const hubNonce = secureNonce()
    const context = { ...lanRequestContext(hubNonce, Date.now()), requestId: newRequestId() }
    const request = await sealEnvelope({ s: 1 }, code, 'request', context)
    expect(() => openLanEnvelope(request, 'ffffffffffffffffffffffffffffffff', 'request', { hubNonce })).toThrow()
    const reply = sealLanEnvelope({ ok: true }, 'ffffffffffffffffffffffffffffffff', 'response', context)
    await expect(openEnvelope(reply, code, 'response', context)).rejects.toThrow('не тим кодом')
    const other = sealLanEnvelope({ ok: true }, code, 'response', { ...context, requestId: newRequestId() })
    await expect(openEnvelope(other, code, 'response', context)).rejects.toThrow('не тим кодом')
  })
})
