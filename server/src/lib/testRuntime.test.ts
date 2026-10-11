import { expect, it } from 'vitest'
import config from '../../vitest.config'

it('keeps the database test runtime in a bounded child process', () => {
  expect(config.test?.pool).toBe('forks')
  expect(config.test?.maxWorkers).toBe(1)
  expect(config.test?.isolate).not.toBe(false)
  expect(config.test?.dangerouslyIgnoreUnhandledErrors).not.toBe(true)
  expect(config.test?.passWithNoTests).not.toBe(true)
})

it('passes the Node 24 WASM workaround to the actual test process only', () => {
  const needsWorkaround = process.versions.node.startsWith('24.')
  expect(config.test?.execArgv).toEqual(needsWorkaround ? ['--no-wasm-code-gc'] : [])
  if (needsWorkaround) expect(process.execArgv).toContain('--no-wasm-code-gc')
})

it('still runs WebAssembly rather than skipping database execution', async () => {
  const module = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
  expect(new WebAssembly.Instance(module).exports).toEqual({})
})
