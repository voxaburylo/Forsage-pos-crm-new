import type { Response } from 'express'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

// At most 16 Ki UTF-16 units / 48 KiB UTF-8 per write, including long single fields.
export const SYNC_JSON_CHUNK_CHARS = 16 * 1024

/** Same JSON envelope as res.json({ data }), without a second full response string.
 * The service must finish and validate the database snapshot before calling this.
 * Arrays are serialized row by row; no cursor or partial result is sent separately. */
function* fragments(data: Record<string, unknown>): Generator<string> {
  yield '{"data":{'
  let firstField = true
  for (const key of Object.keys(data)) {
    const value = data[key]
    if (Array.isArray(value)) {
      yield (firstField ? '' : ',') + JSON.stringify(key) + ':['
      firstField = false
      for (let index = 0; index < value.length; index++) {
        if (index) yield ','
        yield JSON.stringify(value[index]) ?? 'null'
      }
      yield ']'
    } else {
      const encoded = JSON.stringify(value)
      if (encoded === undefined) continue
      yield (firstField ? '' : ',') + JSON.stringify(key) + ':' + encoded
      firstField = false
    }
  }
  yield '}}'
}

export function* syncJsonChunks(data: Record<string, unknown>): Generator<string> {
  let pending = ''
  for (const fragment of fragments(data)) {
    let offset = 0
    while (offset < fragment.length) {
      const take = Math.min(SYNC_JSON_CHUNK_CHARS - pending.length, fragment.length - offset)
      pending += fragment.slice(offset, offset + take)
      offset += take
      if (pending.length === SYNC_JSON_CHUNK_CHARS) {
        // Never encode the two halves of an emoji in separate UTF-8 writes.
        const last = pending.charCodeAt(pending.length - 1)
        const carry = last >= 0xd800 && last <= 0xdbff ? pending.slice(-1) : ''
        yield carry ? pending.slice(0, -1) : pending
        pending = carry
      }
    }
  }
  if (pending) yield pending
}

export async function streamSyncJson(res: Response, data: Record<string, unknown>): Promise<void> {
  if (res.destroyed) throw new Error('SYNC_RESPONSE_CLOSED')
  const chunks = syncJsonChunks(data)
  // A small invalid response can still return the normal API error before headers.
  const first = chunks.next()
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'private, no-store, no-transform')
  res.removeHeader('Content-Length')
  // Do not use res.send/json: those buffer the whole body and set Content-Length.
  await pipeline(Readable.from((async function* () {
    try {
      if (!first.done) yield first.value
      for (const chunk of chunks) {
        await yieldToEventLoop()
        if (res.destroyed) throw new Error('SYNC_RESPONSE_CLOSED')
        yield chunk
      }
    } finally { chunks.return(undefined) }
  })(), { objectMode: false, highWaterMark: 64 * 1024 }), res)
}
