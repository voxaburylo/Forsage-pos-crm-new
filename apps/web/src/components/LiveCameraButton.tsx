import { useEffect, useState } from 'react'
import { Camera } from 'lucide-react'
import { LIVE_CAMERA_STATE_EVENT, liveCameraStoredOn, toggleLiveCamera } from '@/lib/cameraScan'
import { isDesktopRuntime } from '@/lib/desktopBridge'

/**
 * Значок камери біля поля пошуку (каса, товари, ревізія) у вебі. Не відкриває вікно з картинкою:
 * вмикає/вимикає постійний сканер (LiveCameraScanner). Дія на pointerdown з preventDefault — курсор
 * лишається в полі, а код потрапляє туди ж, куди й код USB-сканера (25.11.2026, слово власника).
 */
export function LiveCameraButton({ className = '', size = 20, label = 'Сканувати камерою' }: { className?: string; size?: number; label?: string }) {
  const [on, setOn] = useState(liveCameraStoredOn)
  useEffect(() => {
    const listener = (event: Event) => setOn(Boolean((event as CustomEvent<{ on?: boolean }>).detail?.on))
    window.addEventListener(LIVE_CAMERA_STATE_EVENT, listener)
    return () => window.removeEventListener(LIVE_CAMERA_STATE_EVENT, listener)
  }, [])
  // У програмі на ПК — USB-сканер; камера там не вмикається (LiveCameraScanner у програмі не працює).
  if (isDesktopRuntime()) return null
  return (
    <button type="button" data-live-camera-button={on ? 'on' : 'off'}
      onPointerDown={event => { event.preventDefault(); toggleLiveCamera() }}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleLiveCamera() } }}
      aria-label={on ? 'Вимкнути сканер камерою' : label} aria-pressed={on} title={on ? 'Вимкнути сканер камерою' : label}
      className={`${className} ${on ? '!bg-yellow-400 !text-black' : ''}`}>
      <Camera size={size} />
    </button>
  )
}
