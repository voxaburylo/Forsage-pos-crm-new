import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const seed = readFileSync(new URL('../../seed.ts', import.meta.url), 'utf8')
const setupOwner = readFileSync(new URL('../../../scripts/setup-owner.ts', import.meta.url), 'utf8')

describe('administrative bootstrap safety', () => {
  it('requires explicit seed confirmation and credentials', () => {
    expect(seed).toContain("process.env.ALLOW_DESTRUCTIVE_SEED !== 'YES'")
    expect(seed).toContain('SEED_OWNER_PHONE')
    expect(seed).toContain('SEED_OWNER_PASSWORD')
    expect(seed).not.toContain("?? 'admin123'")
    expect(seed).not.toContain("password: 'cashier123'")
  })

  it('does not print passwords', () => {
    expect(seed).not.toContain('/ admin123')
    expect(seed).not.toContain('/ cashier123')
    expect(setupOwner).not.toContain('Пароль:   ${password}')
  })
})