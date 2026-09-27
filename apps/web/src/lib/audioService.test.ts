import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('optional POS sound does not break the till', () => {
  let context: { state: string; resume: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; createOscillator: ReturnType<typeof vi.fn>; createGain: ReturnType<typeof vi.fn>; currentTime: number; destination: object }
  let stored: string | null
  const oscillator = () => ({ connect: vi.fn(), disconnect: vi.fn(), frequency: { setValueAtTime: vi.fn() }, start: vi.fn(), stop: vi.fn(), onended: undefined as undefined | (() => void) })
  const gain = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } })
  beforeEach(() => {
    vi.resetModules()
    stored = null
    context = { state: 'running', resume: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), createOscillator: vi.fn(oscillator), createGain: vi.fn(gain), currentTime: 0, destination: {} }
    vi.stubGlobal('localStorage', { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value } })
    vi.stubGlobal('AudioContext', vi.fn(function () { return context }))
  })
  afterEach(() => vi.unstubAllGlobals())
  it('does not create a native sound service when sound is disabled', async () => {
    const audio = await import('./audioService')
    audio.setSoundEnabled(false)
    expect(audio.initAudio()).toBeNull()
    audio.playSuccessBeep()
    expect(AudioContext).not.toHaveBeenCalled()
  })
  it('resumes a previously initialized context after sleep only once per pending request', async () => {
    const audio = await import('./audioService')
    audio.initAudio()
    context.state = 'suspended'
    audio.initAudio(); audio.initAudio()
    expect(context.resume).toHaveBeenCalledOnce()
    expect(AudioContext).toHaveBeenCalledOnce()
  })
  it('consumes failed resume and stops repeated native service starts', async () => {
    context.state = 'suspended'
    context.resume.mockRejectedValue(new Error('audio service gone'))
    const audio = await import('./audioService')
    audio.initAudio()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(audio.initAudio()).toBeNull()
    expect(context.close).toHaveBeenCalledOnce()
    expect(AudioContext).toHaveBeenCalledOnce()
  })
  it('disables audio for this session on native crash without changing saved preferences', async () => {
    const audio = await import('./audioService')
    audio.initAudio(); audio.suspendAudioAfterServiceCrash()
    audio.playCashRegister(); audio.playErrorTone()
    expect(audio.initAudio()).toBeNull()
    expect(audio.isSoundEnabled()).toBe(true)
    expect(context.createOscillator).not.toHaveBeenCalled()
  })
  it('handles constructor failure and closed contexts without repeated exceptions', async () => {
    vi.stubGlobal('AudioContext', vi.fn(function () { throw new Error('no audio device') }))
    const audio = await import('./audioService')
    expect(audio.initAudio()).toBeNull()
    expect(audio.initAudio()).toBeNull()
    expect(AudioContext).toHaveBeenCalledOnce()
  })
  it('disconnects completed audio nodes', async () => {
    const audio = await import('./audioService')
    audio.playCashRegister()
    for (let index = 0; index < context.createOscillator.mock.results.length; index++) {
      const osc = context.createOscillator.mock.results[index].value
      osc.onended()
      expect(osc.disconnect).toHaveBeenCalledOnce()
      expect(context.createGain.mock.results[index].value.disconnect).toHaveBeenCalledOnce()
    }
    expect(context.createOscillator).toHaveBeenCalledTimes(6)
  })
})
