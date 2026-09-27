import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ session: vi.fn(), upload: vi.fn(), remove: vi.fn(), from: vi.fn(), report: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { auth: { getSession: mocks.session }, storage: { from: mocks.from } } }))
vi.mock('./localDiagnostics', () => ({ reportLocalError: mocks.report }))
import { uploadProcessingBlob, removeProcessingUploads } from './processingUploads'
import { reportAiFailure } from '@/features/ai/aiDiagnostics'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const photo = () => new Blob(['fixture'], { type: 'image/png' })
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks()
  mocks.session.mockResolvedValue({ data: { session: { user: { id: 'fixture-user' } } }, error: null })
  mocks.upload.mockResolvedValue({ error: null })
  mocks.remove.mockResolvedValue({ error: null })
  mocks.from.mockReturnValue({ upload: mocks.upload, remove: mocks.remove })
})
afterEach(() => { vi.useRealTimers() })
describe('temporary processing upload safety', () => {
  it('classifies the real upload timeout by code through a wrapped diagnostic', async () => {
    mocks.upload.mockReturnValue(new Promise(() => {}))
    const pending = uploadProcessingBlob(photo(), 'ai').catch(error => {
      reportAiFailure('recognition', Object.assign(Error('wrapper'), { cause: error }))
      return error
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await pending).toMatchObject({ code: 'PROCESSING_TIMEOUT' })
    expect(mocks.report.mock.lastCall![0].message).toBe('AI_OPERATION_RECOGNITION_TIMEOUT')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('uses a unique scoped path without overwrite and clears timers', async () => {
    const first = await uploadProcessingBlob(photo(), 'ai')
    const second = await uploadProcessingBlob(photo(), 'ai')
    expect(first.path).toMatch(/^fixture-user\/ai\/.+\.png$/)
    expect(first.path).not.toBe(second.path)
    expect(mocks.from).toHaveBeenCalledWith('processing-uploads')
    expect(mocks.upload.mock.calls[0][2]).toEqual({ contentType: 'image/png', cacheControl: '60', upsert: false })
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([new Blob([]), new Blob([new Uint8Array(25 * 1024 * 1024 + 1)])])('rejects invalid size before auth/upload', async blob => {
    await expect(uploadProcessingBlob(blob, 'ai')).rejects.toThrow()
    expect(mocks.session).not.toHaveBeenCalled()
  })
  it('does not upload after a late session response', async () => {
    const pending = deferred<unknown>(); mocks.session.mockReturnValue(pending.promise)
    const result = expect(uploadProcessingBlob(photo(), 'ai')).rejects.toThrow('Перевірка сесії')
    await vi.advanceTimersByTimeAsync(15_000); await result
    pending.resolve({ data: { session: { user: { id: 'fixture-user' } } }, error: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([
    { data: { session: null }, error: null },
    { data: { session: { user: { id: 'fixture-user' } } }, error: { message: 'secret' } },
  ])('rejects unavailable session', async value => {
    mocks.session.mockResolvedValue(value)
    await expect(uploadProcessingBlob(photo(), 'ai')).rejects.toThrow()
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it.each(['resolve', 'reject'] as const)('cleans abandoned upload again on late %s without deleting a retry', async completion => {
    const pending = deferred<{ error: null }>()
    mocks.upload.mockReturnValueOnce(pending.promise)
    const failed = expect(uploadProcessingBlob(photo(), 'ai')).rejects.toThrow('Завантаження файла')
    await vi.advanceTimersByTimeAsync(60_000); await failed
    const abandoned = mocks.upload.mock.calls[0][0]
    expect(mocks.remove).toHaveBeenCalledWith([abandoned])
    const retry = await uploadProcessingBlob(photo(), 'ai')
    if (completion === 'resolve') pending.resolve({ error: null })
    else pending.reject(Error('secret upstream exception'))
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.remove.mock.calls).toEqual([[[abandoned]], [[abandoned]]])
    expect(retry.path).not.toBe(abandoned)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('handles upload SDK errors without exposing raw server content', async () => {
    mocks.upload.mockResolvedValue({ error: { message: 'secret token and invoice' } })
    await expect(uploadProcessingBlob(photo(), 'vin')).rejects.toThrow('Не вдалося підготувати файл.')
    expect(mocks.remove).toHaveBeenCalledTimes(1)
  })
  it('deduplicates exact cleanup targets and ignores empty list', async () => {
    await removeProcessingUploads([])
    expect(mocks.remove).not.toHaveBeenCalled()
    await removeProcessingUploads(['a/ai/one.png', 'a/ai/one.png'])
    expect(mocks.remove).toHaveBeenCalledWith(['a/ai/one.png'])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('reports removal errors with a fixed private diagnostic', async () => {
    mocks.remove.mockResolvedValue({ error: { message: 'private path and token' } })
    await expect(removeProcessingUploads(['private/path'])).rejects.toThrow('Не вдалося очистити')
    const error = mocks.report.mock.calls[0][0] as Error
    expect(error.message).toBe('AI_PROCESSING_CLEANUP_FAILED')
    expect(error.stack).not.toContain('private')
  })
  it('bounds cleanup wait even when SDK never returns', async () => {
    mocks.remove.mockReturnValue(new Promise(() => {}))
    const failure = expect(removeProcessingUploads(['one'])).rejects.toThrow('Не вдалося очистити')
    await vi.advanceTimersByTimeAsync(5_000); await failure
    expect(mocks.report).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
