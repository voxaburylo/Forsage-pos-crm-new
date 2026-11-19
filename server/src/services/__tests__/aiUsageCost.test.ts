import { describe, expect, it } from 'vitest'
import { claudeUsageFrom } from '../aiClaude.js'

describe('assistant cost counter', () => {
  it('prices cache reads cheaply, cache writes at +25 % and counts web searches', () => {
    const usage = claudeUsageFrom({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 100_000, server_tool_use: { web_search_requests: 3 } })
    expect(usage.promptTokens).toBe(1_101_000)
    // 1M cached tokens: full price would be $2.00, real price $0.10 → adjust -1.90; writes +$0.05; 3 searches +$0.03
    expect(usage.costAdjustUsd).toBeCloseTo(-1.90 + 0.05 + 0.03, 6)
    const plain = claudeUsageFrom({ input_tokens: 10, output_tokens: 5 })
    expect(plain.costAdjustUsd).toBe(0)
  })
})
