import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ from: vi.fn(), download: vi.fn(), remove: vi.fn(), warn: vi.fn() }))
vi.mock('../db/supabase.js', () => ({ db: { storage: { from: mocks.from } } }))
vi.mock('../lib/logger.js', () => ({ logger: { warn: mocks.warn } }))
import { downloadProcessingUpload, removeProcessingUploads, PROCESSING_UPLOAD_BUCKET } from './processingUploadService.js'

const user = '00000000-0000-4000-8000-000000000001'
const foreign = '00000000-0000-4000-8000-000000000002'
const file = '00000000-0000-4000-8000-000000000003'
const path = user + '/ai/' + file + '.png'
const options = { path, userId: user, purpose: 'ai' as const, maxBytes: 100, allowedMimeTypes: ['image/png'] }
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks()
  mocks.from.mockReturnValue({ download: mocks.download, remove: mocks.remove })
  mocks.download.mockResolvedValue({ data: new Blob(['photo'], { type: 'image/png' }), error: null })
  mocks.remove.mockResolvedValue({ data: [], error: null })
})
afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.useRealTimers() })

describe('private temporary processing uploads', () => {
  it('downloads only an owned file of the requested purpose', async () => {
    const result = await downloadProcessingUpload(options)
    expect(result).toEqual({ buffer: Buffer.from('photo'), mimeType: 'image/png' })
    expect(mocks.from).toHaveBeenCalledWith(PROCESSING_UPLOAD_BUCKET)
    expect(mocks.download).toHaveBeenCalledWith(path)
  })
  it.each([
    foreign + '/ai/' + file + '.png',
    user + '/vin/' + file + '.png',
    user + '/ai/../' + file + '.png',
    'https://private.example/' + path,
    path + '?token=PRIVATE_SECRET',
  ])('denies an unowned or malformed path before network access: %s', async invalid => {
    await expect(downloadProcessingUpload({ ...options, path: invalid })).rejects.toMatchObject({ status: expect.any(Number) })
    expect(mocks.from).not.toHaveBeenCalled()
  })
  it('returns no provider data when a private object is unavailable', async () => {
    mocks.download.mockResolvedValue({ data: null, error: { message: 'PRIVATE_SECRET' } })
    const error = await downloadProcessingUpload(options).catch(error => error)
    expect(error.code).toBe('UPLOAD_NOT_FOUND')
    expect(error.message).not.toContain('PRIVATE_SECRET')
  })
  it('rejects an oversized photo before reading its bytes', async () => {
    const arrayBuffer = vi.fn()
    mocks.download.mockResolvedValue({ data: { size: 101, type: 'image/png', arrayBuffer }, error: null })
    await expect(downloadProcessingUpload(options)).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE' })
    expect(arrayBuffer).not.toHaveBeenCalled()
  })
  it('rejects unsupported file content before reading its bytes', async () => {
    const arrayBuffer = vi.fn()
    mocks.download.mockResolvedValue({ data: { size: 5, type: 'text/html', arrayBuffer }, error: null })
    await expect(downloadProcessingUpload(options)).rejects.toMatchObject({ code: 'UPLOAD_TYPE_NOT_ALLOWED' })
    expect(arrayBuffer).not.toHaveBeenCalled()
  })
  it('deduplicates owned paths and never deletes foreign objects', async () => {
    const vinPath = user + '/vin/' + file + '.jpg'
    await removeProcessingUploads([path, path, vinPath, foreign + '/ai/' + file + '.png', '../private'], user)
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith([path, vinPath])
    expect(mocks.warn).not.toHaveBeenCalled()
  })
  it('does not touch storage if none of the paths are owned', async () => {
    await removeProcessingUploads([foreign + '/ai/' + file + '.png', 'invalid'], user)
    expect(mocks.from).not.toHaveBeenCalled()
  })
  it.each(['returned', 'rejected'])('records a safe diagnostic for a %s cleanup failure', async mode => {
    const error = new Error('Bearer PRIVATE_SECRET data:image/png;base64,PRIVATE_PHOTO')
    if (mode === 'returned') mocks.remove.mockResolvedValue({ data: null, error })
    else mocks.remove.mockRejectedValue(error)
    const failure = await removeProcessingUploads([path], user).catch(error => error)
    expect(failure).toMatchObject({ code: 'AI_PROCESSING_CLEANUP_FAILED', status: 502 })
    expect(mocks.warn).toHaveBeenCalledOnce()
    const diagnostic = JSON.stringify(mocks.warn.mock.calls)
    for (const secret of ['PRIVATE_SECRET', 'PRIVATE_PHOTO', path, user]) expect(diagnostic).not.toContain(secret)
    expect(diagnostic).toContain('AI_PROCESSING_CLEANUP_FAILED')
    expect(failure.message).not.toContain('PRIVATE_')
    expect(mocks.remove).toHaveBeenCalledOnce()
  })
  it('bounds stuck cleanup and ignores its late failure without retrying', async () => {
    let reject!: (error: Error) => void
    mocks.remove.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
    const pending = expect(removeProcessingUploads([path], user)).rejects.toMatchObject({ code: 'AI_PROCESSING_CLEANUP_FAILED' })
    await vi.advanceTimersByTimeAsync(5_000)
    await pending
    expect(mocks.warn).toHaveBeenCalledOnce()
    reject(new Error('PRIVATE_LATE_FAILURE'))
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.remove).toHaveBeenCalledOnce()
    expect(mocks.warn).toHaveBeenCalledOnce()
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('PRIVATE_')
  })
})
