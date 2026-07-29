import { describe, expect, it } from 'vitest'
import {
  hashSecret,
  isSupportedSecretHash,
  legacySecretHash,
  secretHashNeedsUpgrade,
  verifySecret,
} from './secretHash.js'

describe('secretHash', () => {
  it('uses a random versioned salt and verifies without exposing the secret', () => {
    const first = hashSecret('1234')
    const second = hashSecret('1234')
    expect(first).not.toBe(second)
    expect(first).not.toContain('1234')
    expect(isSupportedSecretHash(first)).toBe(true)
    expect(verifySecret(first, '1234', 'ignored')).toBe(true)
    expect(verifySecret(first, '4321', 'ignored')).toBe(false)
    expect(secretHashNeedsUpgrade(first)).toBe(false)
  })

  it('accepts the legacy deterministic format only for migration', () => {
    const legacy = legacySecretHash('5678', 'staff-user')
    expect(verifySecret(legacy, '5678', 'staff-user')).toBe(true)
    expect(verifySecret(legacy, '5678', 'another-user')).toBe(false)
    expect(secretHashNeedsUpgrade(legacy)).toBe(true)
  })

  it('rejects malformed and deliberately excessive work factors', () => {
    expect(isSupportedSecretHash('pbkdf2-sha512$999999999$YWJj$YWJj')).toBe(false)
    expect(verifySecret('not-a-hash', '1234', 'staff-user')).toBe(false)
  })
})