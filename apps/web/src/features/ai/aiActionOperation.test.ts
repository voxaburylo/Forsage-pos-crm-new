import { describe, expect, it } from 'vitest'
import { aiActionOperationId } from './aiActionOperation'
describe('AI order retry identity', () => {
  it('replays the same confirmed action after restart but separates users and actions', async () => {
    const first=await aiActionOperationId('tenant:user','action1')
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(await aiActionOperationId('tenant:user','action1')).toBe(first)
    expect(await aiActionOperationId('tenant:other','action1')).not.toBe(first)
    expect(await aiActionOperationId('tenant:user','action2')).not.toBe(first)
  })
  it('blocks missing identity', async () => {
    await expect(aiActionOperationId('','x')).rejects.toThrow('ідентифікатора')
    await expect(aiActionOperationId('scope','')).rejects.toThrow('ідентифікатора')
  })
})
