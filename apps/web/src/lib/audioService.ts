/**
 * Аудіо-сервіс для POS-термінала.
 * Використовує Web Audio API (OscillatorNode) — без зовнішніх файлів.
 * Стан звуку (mute) зберігається в localStorage.
 */

const STORAGE_KEY = 'forsage_pos_sound_enabled'

// ================================================================
// Стан та lazy ініціалізація
// ================================================================

let audioCtx: AudioContext | null = null
let _initialized = false

/** Ініціалізація AudioContext при першій взаємодії користувача */
export function initAudio(): AudioContext | null {
  if (_initialized && audioCtx) return audioCtx
  try {
    // Resume, якщо контекст у suspended стані (autoplay policy)
    if (audioCtx?.state === 'suspended') {
      audioCtx.resume()
      return audioCtx
    }
    audioCtx = new AudioContext()
    _initialized = true
    return audioCtx
  } catch {
    return null
  }
}

// ================================================================
// Mute control (localStorage)
// ================================================================

export function isSoundEnabled(): boolean {
  const stored = localStorage.getItem(STORAGE_KEY)
  // Default: enabled (true), тільки якщо явно 'false' — вимкнено
  return stored !== 'false'
}

export function setSoundEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false')
}

export function toggleSound(): boolean {
  const next = !isSoundEnabled()
  setSoundEnabled(next)
  return next
}

// ================================================================
// Допоміжні функції для створення звуків
// ================================================================

function playOscillator(
  frequency: number,
  duration: number,
  type: OscillatorType,
  volume = 0.3,
  startDelay = 0,
): void {
  if (!isSoundEnabled()) return
  const ctx = initAudio()
  if (!ctx) return

  try {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.type = type
    osc.frequency.setValueAtTime(frequency, ctx.currentTime + startDelay)
    gain.gain.setValueAtTime(volume, ctx.currentTime + startDelay)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startDelay + duration)

    osc.start(ctx.currentTime + startDelay)
    osc.stop(ctx.currentTime + startDelay + duration)
  } catch {
    // Ігноруємо помилки аудіо (браузер може не підтримувати)
  }
}

// ================================================================
// Публічні звукові сигнали
// ================================================================

/**
 * Успішне сканування / додавання товару.
 * Короткий високий beep: 800Hz, 200ms, sine.
 */
export function playSuccessBeep(): void {
  playOscillator(800, 0.2, 'sine', 0.3)
}

/**
 * Помилка / товар не знайдено.
 * Низький тон: 400Hz, 300ms, square (подвійний).
 */
export function playErrorTone(): void {
  playOscillator(400, 0.3, 'square', 0.25, 0)
  playOscillator(330, 0.3, 'square', 0.25, 0.4)
}

/**
 * Попередження / дублікат товару / нестача.
 * Два швидких імпульси: 500Hz + 400Hz.
 */
export function playWarning(): void {
  playOscillator(500, 0.15, 'sawtooth', 0.2, 0)
  playOscillator(400, 0.15, 'sawtooth', 0.2, 0.2)
}

/**
 * Продаж завершено (касовий апарат).
 * Висхідний акорд: три тони.
 */
export function playCashRegister(): void {
  if (!isSoundEnabled()) return
  const ctx = initAudio()
  if (!ctx) return

  try {
    // Акорд: C5 + E5 + G5 (до-мажор)
    const freqs = [523, 659, 784]

    freqs.forEach((freq) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, ctx.currentTime)
      gain.gain.setValueAtTime(0.15, ctx.currentTime)
      gain.gain.setValueAtTime(0.15, ctx.currentTime + 0.15)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5)
      osc.start(ctx.currentTime)
      osc.stop(ctx.currentTime + 0.5)
    })

    // Повторення акорду через 300ms для ефекту "касового апарату"
    freqs.forEach((freq) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, ctx.currentTime + 0.3)
      gain.gain.setValueAtTime(0.1, ctx.currentTime + 0.3)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8)
      osc.start(ctx.currentTime + 0.3)
      osc.stop(ctx.currentTime + 0.8)
    })
  } catch {
    // Ігноруємо
  }
}
