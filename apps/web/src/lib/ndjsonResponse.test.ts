import { expect, it, vi } from 'vitest'
import { readNdjsonResponse } from './api'

const stream = (chunks: string[]) => new ReadableStream<Uint8Array>({
  start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close() },
})

it('reports progress lines and returns the final data, even when lines are split across chunks', async () => {
  const progress = vi.fn()
  const result = await readNdjsonResponse<{ data: { reply: string } }>(stream([
    '{"progress":{"stage":"start"}}\n{"progress":{"stage":"to', 'ols","tools":["search_products"]}}\n',
    '{"data":{"reply":"Є 3 шт"}}\n',
  ]), progress)
  expect(progress.mock.calls.map(call => call[0])).toEqual([{ stage: 'start' }, { stage: 'tools', tools: ['search_products'] }])
  expect(result).toEqual({ data: { reply: 'Є 3 шт' } })
})

it('throws the server error from the stream', async () => {
  await expect(readNdjsonResponse(stream(['{"progress":{"stage":"start"}}\n{"error":{"code":"AI_TIMEOUT","message":"ШІ не завершив","status":504}}\n']), () => {}))
    .rejects.toMatchObject({ code: 'AI_TIMEOUT', status: 504 })
})

it('does not invent a result when the stream breaks off', async () => {
  await expect(readNdjsonResponse(stream(['{"progress":{"stage":"start"}}\n']), () => {})).rejects.toThrow('обірвалась')
})
