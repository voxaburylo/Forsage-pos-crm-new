import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileToCompressedImage } from './aiImageInput'

describe('AI photo preparation', () => {
  let image: { onload: (()=>void) | null; onerror: (()=>void) | null; src: string; naturalWidth: number; naturalHeight: number }
  let canvas: { width: number; height: number; getContext: ReturnType<typeof vi.fn>; toDataURL: ReturnType<typeof vi.fn> }
  let context: { fillStyle: string; fillRect: ReturnType<typeof vi.fn>; drawImage: ReturnType<typeof vi.fn> }
  let revoke: ReturnType<typeof vi.fn>
  const file = { name: 'clipboard.png', size: 1234 } as File
  beforeEach(() => {
    vi.useFakeTimers()
    image = { onload: null, onerror: null, src: '', naturalWidth: 3600, naturalHeight: 2400 }
    context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() }
    canvas = { width: 0, height: 0, getContext: vi.fn(()=>context), toDataURL: vi.fn(()=> 'data:image/jpeg;base64,1234567890') }
    revoke = vi.fn()
    vi.stubGlobal('Image', class { constructor() { return image } })
    vi.stubGlobal('URL', { createObjectURL: vi.fn(()=> 'blob:test'), revokeObjectURL: revoke })
    vi.stubGlobal('document', { createElement: vi.fn(()=>canvas) })
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  it('paints white before transparent source and retains dimensions and name', async () => {
    const pending = fileToCompressedImage(file); image.onload!()
    expect(await pending).toEqual({ name: 'clipboard.png', dataUrl: 'data:image/jpeg;base64,1234567890' })
    expect([canvas.width, canvas.height]).toEqual([1800,1200])
    expect(context.fillStyle).toBe('#ffffff')
    expect(context.fillRect).toHaveBeenCalledWith(0,0,1800,1200)
    expect(context.fillRect.mock.invocationCallOrder[0]).toBeLessThan(context.drawImage.mock.invocationCallOrder[0])
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/jpeg',0.88)
    expect(revoke).toHaveBeenCalledWith('blob:test')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not enlarge small images', async () => {
    image.naturalWidth=300; image.naturalHeight=600
    const pending=fileToCompressedImage(file); image.onload!(); await pending
    expect([canvas.width,canvas.height]).toEqual([300,600])
  })
  it('bounds decoding and releases handlers and the URL on timeout', async () => {
    const pending=fileToCompressedImage(file)
    const check=expect(pending).rejects.toThrow('15 секунд')
    await vi.advanceTimersByTimeAsync(15_000); await check
    expect(image.onload).toBeNull(); expect(image.onerror).toBeNull()
    expect(image.src).toBe(''); expect(revoke).toHaveBeenCalledOnce()
    expect(context.drawImage).not.toHaveBeenCalled()
  })
  it('cleans up invalid files and encoding failures', async () => {
    const pending=fileToCompressedImage(file); image.onerror!()
    await expect(pending).rejects.toThrow('прочитати')
    expect(revoke).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
    canvas.toDataURL.mockReturnValue('data:,')
    const invalid=fileToCompressedImage(file); image.onload!()
    await expect(invalid).rejects.toThrow('підготувати')
    expect(revoke).toHaveBeenCalledTimes(2)
  })
  it('rejects zero dimensions, empty and oversized inputs', async () => {
    await expect(fileToCompressedImage({...file,size:0})).rejects.toThrow('порожнє')
    await expect(fileToCompressedImage({...file,size:20*1024*1024+1})).rejects.toThrow('20 МБ')
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    image.naturalWidth=0
    const pending=fileToCompressedImage(file); image.onload!()
    await expect(pending).rejects.toThrow('розміру')
    expect(revoke).toHaveBeenCalledOnce()
  })
})
