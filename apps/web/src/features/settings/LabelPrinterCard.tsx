import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Tag } from 'lucide-react'
import { Card } from '@/components/ui'
import { desktopBridge } from '@/lib/desktopBridge'
import { isReceiptPrinterName, loadTsplSettings, saveTsplSettings } from '@/features/labels/tsplPrintSettings'

/**
 * 21.11.2026 (план «порядок у налаштуваннях»): принтер етикеток вибирався лише всередині «Друк етикеток»,
 * а принтер чеків — тут. Тепер обидва в «Каса і друк». Налаштування те саме (той самий запис на цьому ПК),
 * тож вибір тут і в дизайнері етикеток — одне й те саме.
 */
export function LabelPrinterCard() {
  const navigate = useNavigate()
  const [printers, setPrinters] = useState<Array<{ name: string; displayName: string }>>([])
  const [printerName, setPrinterName] = useState(() => loadTsplSettings().printerName)
  useEffect(() => {
    const list = desktopBridge()?.print?.listPrinters
    if (typeof list !== 'function') return
    list().then(setPrinters).catch(() => setPrinters([]))
  }, [])
  const choose = (name: string) => {
    setPrinterName(name)
    saveTsplSettings({ ...loadTsplSettings(), printerName: name })
  }
  return (
    <Card className="mt-6 space-y-3">
      <div className="flex items-center gap-2 pb-3 border-b border-gray-100"><Tag size={18} className="text-gray-500" /><h3 className="text-sm font-semibold text-gray-800">Принтер етикеток (цей комп'ютер)</h3></div>
      {printers.length > 0 ? (
        <select value={printerName} onChange={event => choose(event.target.value)} aria-label="Принтер етикеток"
          className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm">
          <option value="">Визначати автоматично</option>
          {printers.filter(printer => !isReceiptPrinterName(printer.name) || printer.name === printerName).map(printer => (
            <option key={printer.name} value={printer.name}>{printer.displayName || printer.name}</option>
          ))}
        </select>
      ) : (
        <p className="text-sm text-gray-600">Зараз: {printerName || 'визначається автоматично'}. Список принтерів доступний у програмі на касі.</p>
      )}
      <button type="button" onClick={() => navigate('/labels')} className="text-sm text-blue-700 underline">Розмір і вигляд етикетки — у «Друк етикеток»</button>
    </Card>
  )
}
