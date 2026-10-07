import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiClipboardTimeoutError, readAiClipboard } from './readAiClipboard'

describe('explicit AI clipboard read', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
  it('uses plain text when a spreadsheet supplies both text and an image', async () => {
    const getType = vi.fn(async () => new Blob(['Назва\tКількість\nКлюч\t1']))
    expect(await readAiClipboard({ read: async () => [{ types: ['image/png', 'text/plain'], getType }] }))
      .toEqual({ text: 'Назва\tКількість\nКлюч\t1' })
    expect(getType).toHaveBeenCalledExactlyOnceWith('text/plain')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('preserves image files without sending them anywhere', async () => {
    const result = await readAiClipboard({ read: async () => [
      { types: ['image/png'], getType: async () => new Blob(['one'], { type: 'image/png' }) },
      { types: ['image/jpeg'], getType: async () => new Blob(['two'], { type: 'image/jpeg' }) },
    ] })
    expect(result && 'files' in result && result.files.map(file => [file.type, file.size])).toEqual([['image/png', 3], ['image/jpeg', 3]])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('supports readText-only browsers and keeps the clipboard method receiver', async () => {
    const source = { value: 'Ключ', async readText() { return this.value } }
    expect(await readAiClipboard(source)).toEqual({ text: 'Ключ' })
  })
  it.each([undefined, {}, { read: async () => [] }])('returns no content for unavailable or empty clipboard', async source => {
    expect(await readAiClipboard(source)).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not silently switch to another read when permission was denied', async () => {
    const fallback = vi.fn()
    await expect(readAiClipboard({ read: async () => { throw new Error('denied') }, readText: fallback })).rejects.toThrow('denied')
    expect(fallback).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('times out a pending permission and ignores its late result', async () => {
    let resolve!: (text: string) => void
    const result = readAiClipboard({ readText: () => new Promise(done => { resolve = done }) })
    const rejected = expect(result).rejects.toBeInstanceOf(AiClipboardTimeoutError)
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected
    resolve('late')
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds a pending getType with the same deadline', async () => {
    const result = readAiClipboard({ read: async () => [{ types: ['text/plain'], getType: () => new Promise(() => {}) }] }, 50)
    const rejected = expect(result).rejects.toBeInstanceOf(AiClipboardTimeoutError)
    await vi.advanceTimersByTimeAsync(50)
    await rejected
  })
  it('cleans the timer when reading a blob fails', async () => {
    await expect(readAiClipboard({ read: async () => [{ types: ['image/png'], getType: async () => { throw new Error('blob unavailable') } }] }))
      .rejects.toThrow('blob unavailable')
    expect(vi.getTimerCount()).toBe(0)
  })
})
