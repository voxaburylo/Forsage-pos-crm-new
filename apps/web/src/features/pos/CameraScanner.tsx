import { useEffect, useRef } from 'react'
import { X, Camera } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
  onScan: (code: string) => void
}

export function CameraScanner({ open, onClose, onScan }: Props) {
  const videoRef = useRef<HTMLDivElement>(null)
  const scannerRef = useRef<any>(null)
  const onScanRef = useRef(onScan)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onScanRef.current = onScan
    onCloseRef.current = onClose
  }, [onScan, onClose])

  useEffect(() => {
    if (!open) return
    let mounted = true

    async function start() {
      try {
        const { Html5Qrcode } = await import('html5-qrcode')
        if (!mounted || !videoRef.current) return

        const scanner = new Html5Qrcode('scanner-container')
        scannerRef.current = scanner

        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 150 } },
          (decodedText: string) => {
            scanner.stop().catch(() => {})
            if (mounted) {
              onScanRef.current(decodedText)
              onCloseRef.current()
            }
          },
          () => {},
        )
      } catch {
        // Camera not available
      }
    }

    start()

    return () => {
      mounted = false
      const s = scannerRef.current
      if (s) {
        scannerRef.current = null
        s.stop().catch(() => {})
      }
    }
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-black">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-900 shrink-0">
        <h3 className="text-white font-semibold text-sm flex items-center gap-2">
          <Camera size={16} /> Сканування штрих-коду
        </h3>
        <button onClick={onClose} className="text-gray-400 hover:text-white">
          <X size={20} />
        </button>
      </div>

      {/* Scanner viewport */}
      <div className="flex-1 flex items-center justify-center bg-black relative">
        <div id="scanner-container" ref={videoRef} className="w-full max-w-md" />
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
          <div className="w-64 h-40 border-2 border-yellow-400 rounded-xl opacity-60" />
        </div>
      </div>

      <div className="px-4 py-4 bg-gray-900 text-center text-gray-400 text-sm shrink-0">
        Наведіть камеру на штрих-код товару
      </div>
    </div>
  )
}
