import { describe, expect, it } from 'vitest'
import { createUserSchema } from './adminSchema.js'

describe('createUserSchema access credentials', () => {
  it('allows a tire worker to be created without phone or password', () => {
    const result = createUserSchema.safeParse({
      full_name: 'Майстер шиномонтажу',
      role: 'tire_worker',
    })

    expect(result.success).toBe(true)
  })

  it('still requires phone and password for a program user', () => {
    const result = createUserSchema.safeParse({
      full_name: 'Касир',
      role: 'cashier',
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.phone).toContain('Телефон обов’язковий')
      expect(result.error.flatten().fieldErrors.password).toContain('Пароль обов’язковий')
    }
  })
})