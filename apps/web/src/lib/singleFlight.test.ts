import { describe, expect, it } from 'vitest'
import { SingleFlight } from './singleFlight'

describe('SingleFlight', () => {
  it('shares one live action and releases it after completion', async () => {
    let finish!: (value: number) => void
    const gate = new SingleFlight<number>()
    let starts = 0
    const action = () => {
      starts += 1
      return new Promise<number>((resolve) => { finish = resolve })
    }

    const first = gate.run(action)
    const repeated = gate.run(action)
    expect(repeated).toBe(first)
    expect(starts).toBe(0)
    await Promise.resolve()
    expect(starts).toBe(1)

    finish(7)
    await expect(first).resolves.toBe(7)
    await Promise.resolve()
    expect(gate.isActive).toBe(false)

    await expect(gate.run(async () => 8)).resolves.toBe(8)
  })

  it('releases a rejected action', async () => {
    const gate = new SingleFlight<void>()
    await expect(gate.run(async () => { throw new Error('failed') })).rejects.toThrow('failed')
    await Promise.resolve()
    expect(gate.isActive).toBe(false)
  })
})

