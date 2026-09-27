import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProductPhotoUpload, compressToJpeg, readClipboardImage, uploadToStorage } from './ProductPhotoUpload'

const { savePhoto } = vi.hoisted(() => ({ savePhoto: vi.fn() }))
vi.mock('@/lib/desktopBridge', () => ({ desktopBridge: () => ({ catalog: { savePhoto } }) }))

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); savePhoto.mockReset() })

describe('product photo uploads', () => {
  it('uses local storage and transfers the actual bytes', async () => {
    savePhoto.mockResolvedValue('file:///C:/photos/image.jpg')
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })
    expect(await uploadToStorage(blob, 'product-1')).toBe('file:///C:/photos/image.jpg')
    expect(savePhoto.mock.calls[0][0]).toBe('product-1')
    expect([...new Uint8Array(savePhoto.mock.calls[0][1])]).toEqual([1, 2, 3])
  })
  it('propagates a local permission/save error instead of silently switching to the internet', async () => {
    savePhoto.mockRejectedValue(new Error('Недостатньо прав'))
    await expect(uploadToStorage(new Blob(['photo']), 'p')).rejects.toThrow('Недостатньо прав')
    expect(savePhoto).toHaveBeenCalledOnce()
  })
  it('rejects non-images, empty images and oversized images before decoding', async () => {
    await expect(compressToJpeg(new Blob(['not a picture'], { type: 'text/plain' }))).rejects.toThrow('зображення')
    await expect(compressToJpeg(new Blob([], { type: 'image/jpeg' }))).rejects.toThrow('порожнім')
    await expect(compressToJpeg({ type: 'image/jpeg', size: 21 * 1024 * 1024 } as Blob)).rejects.toThrow('20 МБ')
  })
  it('all photo controls are non-submit buttons and the preview matches the persisted single-photo model', () => {
    const html = renderToStaticMarkup(<ProductPhotoUpload currentPhotoUrl="file:///photo.jpg" onPhotoUrl={() => {}} />)
    const buttons = html.match(/<button[^>]*>/g) ?? []
    expect(buttons).toHaveLength(4)
    for (const button of buttons) expect(button).toContain('type="button"')
    expect(html).not.toContain('multiple')
    expect(html).toContain('src="file:///photo.jpg"')
    const disabled = renderToStaticMarkup(<ProductPhotoUpload disabled onPhotoUrl={() => {}} />)
    for (const button of disabled.match(/<button[^>]*>/g) ?? []) expect(button).toContain('disabled=""')
  })
})

describe('clipboard preparation', () => {
  function clipboard(read: () => Promise<unknown>) {
    vi.stubGlobal('navigator', { clipboard: { read } })
    vi.useFakeTimers()
  }
  it('selects an image and releases the deadline after success', async () => {
    const blob = new Blob(['photo'], { type: 'image/png' })
    clipboard(async () => [{ types: ['text/plain'] }, { types: ['image/png'], getType: async () => blob }])
    expect(await readClipboardImage()).toBe(blob)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('reports a clipboard without images', async () => {
    clipboard(async () => [{ types: ['text/plain'] }])
    await expect(readClipboardImage()).rejects.toThrow('немає зображення')
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['read', 'getType'])('releases the deadline on %s failure', async (stage) => {
    clipboard(async () => {
      if (stage === 'read') throw Error('permission denied')
      return [{ types: ['image/png'], getType: async () => { throw Error('permission denied') } }]
    })
    await expect(readClipboardImage()).rejects.toThrow('permission denied')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('times out a stalled read and never reads the image after the late reply', async () => {
    let resolve!: (value: unknown) => void
    clipboard(() => new Promise((done) => { resolve = done }))
    const result = expect(readClipboardImage()).rejects.toThrow('Немає відповіді')
    await vi.advanceTimersByTimeAsync(3000); await result
    const getType = vi.fn()
    resolve([{ types: ['image/png'], getType }])
    await Promise.resolve()
    expect(getType).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('also times out getType and ignores its late result', async () => {
    let resolve!: (value: Blob) => void
    clipboard(async () => [{ types: ['image/png'], getType: () => new Promise<Blob>((done) => { resolve = done }) }])
    const result = expect(readClipboardImage()).rejects.toThrow('Немає відповіді')
    await vi.advanceTimersByTimeAsync(3000); await result
    resolve(new Blob(['late']))
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('aborts waiting on clipboard data immediately when leaving the card', async () => {
    const controller = new AbortController()
    clipboard(async () => [{ types: ['image/png'], getType: () => new Promise(() => {}) }])
    const result = expect(readClipboardImage(controller.signal)).rejects.toThrow('скасовано')
    await Promise.resolve()
    controller.abort(); await result
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not open the clipboard if the request has already been cancelled', () => {
    const read = vi.fn()
    clipboard(read)
    const controller = new AbortController(); controller.abort()
    expect(() => readClipboardImage(controller.signal)).toThrow()
    expect(read).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('image conversion', () => {
  function mockImage(mode: 'load' | 'error' | 'hang') {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-photo')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const fillRect = vi.fn(), drawImage = vi.fn()
    const ctx = { fillStyle: '', fillRect, drawImage }
    const jpeg = new Blob(['jpeg'], { type: 'image/jpeg' })
    const canvas = { width: 0, height: 0, getContext: () => ctx, toBlob: (done: (blob: Blob) => void) => done(jpeg) }
    vi.stubGlobal('document', { createElement: () => canvas })
    vi.stubGlobal('Image', class {
      width = 2400; height = 1200
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => { if (mode === 'load') this.onload?.(); if (mode === 'error') this.onerror?.() })
      }
    })
    return { revoke, canvas, ctx, jpeg }
  }
  it('resizes and fills transparency white before JPEG conversion, then releases the object URL', async () => {
    const { revoke, canvas, ctx, jpeg } = mockImage('load')
    expect(await compressToJpeg(new Blob(['png'], { type: 'image/png' }))).toBe(jpeg)
    expect([canvas.width, canvas.height]).toEqual([1200, 600])
    expect(ctx.fillStyle).toBe('#fff')
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 1200, 600)
    expect(revoke).toHaveBeenCalledOnce()
  })
  it('reports unsupported/corrupt image formats and releases the object URL', async () => {
    const { revoke } = mockImage('error')
    await expect(compressToJpeg(new Blob(['bad'], { type: 'image/heic' }))).rejects.toThrow('JPG або PNG')
    expect(revoke).toHaveBeenCalledOnce()
  })
  it('does not leave the form blocked forever if the decoder never responds', async () => {
    vi.useFakeTimers()
    const { revoke } = mockImage('hang')
    const result = expect(compressToJpeg(new Blob(['bad'], { type: 'image/jpeg' }))).rejects.toThrow('надто довго')
    await vi.advanceTimersByTimeAsync(15_000)
    await result
    expect(revoke).toHaveBeenCalledOnce()
  })
  it('releases the URL and timer immediately on cancellation', async () => {
    vi.useFakeTimers()
    const { revoke } = mockImage('hang'), controller = new AbortController()
    const result = expect(compressToJpeg(new Blob(['png'], { type: 'image/png' }), controller.signal)).rejects.toThrow('скасовано')
    controller.abort(); await result
    expect(revoke).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects an empty encoder result and releases its resources', async () => {
    const { canvas, revoke } = mockImage('load')
    canvas.toBlob = (done) => done(new Blob())
    await expect(compressToJpeg(new Blob(['png'], { type: 'image/png' }))).rejects.toThrow('підготувати')
    expect(revoke).toHaveBeenCalledOnce()
  })
  it('releases resources if assigning the image source fails', async () => {
    const { revoke } = mockImage('hang')
    vi.stubGlobal('Image', class { set src(_value: string) { throw Error('decoder unavailable') } })
    await expect(compressToJpeg(new Blob(['png'], { type: 'image/png' }))).rejects.toThrow('підготувати')
    expect(revoke).toHaveBeenCalledOnce()
  })
})
