import { useEffect, useId, useRef, useState } from 'react'
import { X, Camera, AlertTriangle } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
  onScan: (code: string) => void
}

export function CameraScanner({ open, onClose, onScan }: Props) {
  const videoRef = useRef<HTMLDivElement>(null)
  const scannerRef = useRef<any>(null)
  const scanHandledRef = useRef(false)
  const onScanRef = useRef(onScan)
  const scannerId = `scanner-${useId().replace(/:/g, '')}`
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    onScanRef.current = onScan
  }, [onScan])

  useEffect(() => {
    if (!open) return
    let mounted = true
    scanHandledRef.current = false
    setError('')
    setStarting(true)

    async function start() {
      try {
        const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import('html5-qrcode')
        if (!mounted || !videoRef.current) return

        const scanner = new Html5Qrcode(scannerId, {
          formatsToSupport: [
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.UPC_A,
            Html5QrcodeSupportedFormats.UPC_E,
            Html5QrcodeSupportedFormats.QR_CODE,
          ],
          verbose: false,
        })
        scannerRef.current = scanner

        await scanner.start(
          { facingMode: 'environment' },
          {
            fps: 10,
            qrbox: (viewfinderWidth, viewfinderHeight) => {
              const maxWidth = Math.max(80, viewfinderWidth - 24)
              const maxHeight = Math.max(60, viewfinderHeight - 24)
              return {
                width: Math.min(maxWidth, Math.max(120, Math.floor(viewfinderWidth * 0.85))),
                height: Math.min(maxHeight, Math.max(80, Math.floor(viewfinderHeight * 0.4))),
              }
            },
          },
          async (decodedText: string) => {
            if (scanHandledRef.current) return
            scanHandledRef.current = true
            try {
              await scanner.stop()
              scanner.clear()
            } catch {}
            scannerRef.current = null
            if (mounted) onScanRef.current(decodedText)
          },
          () => {},
        )
        if (mounted) setStarting(false)
      } catch (err) {
        if (mounted) {
          setStarting(false)
          const denied = err instanceof Error && /permission|notallowed/i.test(err.message)
          setError(denied
            ? 'Доступ до камери заборонено. Дозвольте камеру в налаштуваннях браузера.'
            : 'Камера недоступна на цьому комп’ютері. Скористайтеся ручним пошуком або сканером.')
        }
      }
    }

    start()

    return () => {
      mounted = false
      const s = scannerRef.current
      if (s) {
        scannerRef.current = null
        Promise.resolve(s.stop())
          .catch(() => {})
          .finally(() => {
            try { s.clear() } catch {}
          })
      }
    }
  }, [open, scannerId])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4">
      <div className="flex h-[min(680px,90vh)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-700 bg-black shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-900 shrink-0">
        <h3 className="text-white font-semibold text-sm flex items-center gap-2">
          <Camera size={16} /> Сканування штрих-коду
        </h3>
        <button onClick={onClose} aria-label="Закрити сканер" className="text-gray-400 hover:text-white">
          <X size={20} />
        </button>
      </div>

      {/* Scanner viewport */}
      <div className="flex-1 flex items-center justify-center bg-black relative">
        <div id={scannerId} ref={videoRef} className="min-h-64 w-full max-w-md overflow-hidden bg-black" />
        {!error && <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
          <div className="w-64 h-40 border-2 border-yellow-400 rounded-xl opacity-60" />
        </div>}
        {starting && <p className="absolute text-sm text-gray-400">Підключаємо камеру...</p>}
        {error && (
          <div className="max-w-sm p-6 text-center">
            <AlertTriangle size={40} className="mx-auto mb-3 text-yellow-400" />
            <p className="text-white font-semibold">Не вдалося відкрити камеру</p>
            <p className="mt-2 text-sm text-gray-400">{error}</p>
            <button onClick={onClose} className="mt-5 rounded-xl bg-gray-700 px-5 py-3 text-sm font-semibold text-white hover:bg-gray-600">
              Повернутися до каси
            </button>
          </div>
        )}
      </div>

      <div className="px-4 py-4 bg-gray-900 text-center text-gray-400 text-sm shrink-0">
        Наведіть камеру на штрих-код товару
      </div>
      </div>
    </div>
  )
}
