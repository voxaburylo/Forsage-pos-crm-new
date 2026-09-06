import { describe, expect, it, vi } from 'vitest'
import { PaymentAttempts } from './paymentAttempts'

describe('supplier payment attempts', () => {
  it('shares simultaneous clicks and reuses the id after a lost response', async () => {
    const attempts = new PaymentAttempts<string>(() => 'payment-1')
    const failed = vi.fn(async () => { throw new Error('response lost') })
    const first = attempts.run('invoice/500/cash', failed)
    const second = attempts.run('invoice/500/cash', failed)
    expect(second).toBe(first)
    await expect(first).rejects.toThrow('response lost')
    const retry = vi.fn(async id => id)
    expect(await attempts.run('invoice/500/cash', retry)).toBe('payment-1')
    expect(failed).toHaveBeenCalledOnce()
    expect(retry).toHaveBeenCalledWith('payment-1')
  })
  it('creates a new id for another confirmed payment', async () => {
    let sequence = 0
    const attempts = new PaymentAttempts<string>(() => String(++sequence))
    const send = async (id: string) => id
    expect(await attempts.run('same-details', send)).toBe('1')
    expect(await attempts.run('same-details', send)).toBe('2')
    expect(await attempts.run('different-details', send)).toBe('3')
  })
})
