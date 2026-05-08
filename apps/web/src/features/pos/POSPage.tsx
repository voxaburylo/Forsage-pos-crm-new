import { useState } from 'react'
import { Zap, LogOut, Printer } from 'lucide-react'
import { usePOS } from './usePOS'
import { SearchPanel } from './SearchPanel'
import { ReceiptPanel } from './ReceiptPanel'
import { PaymentModal } from './PaymentModal'
import { ShiftCloseModal } from './ShiftCloseModal'
import { ReceiptPrint, printReceipt } from './ReceiptPrint'
import { QuickCustomerModal } from '@/features/customers/QuickCustomerModal'
import { shiftApi } from './shiftApi'
import type { Customer } from '@/types/customer'
import type { Sale } from '@/types/sale'
import { formatMoney } from '@/lib/utils'
import { toast } from '@/components/ui/Toast'

function OpenShiftScreen({ onOpened }: { onOpened: () => void }) {
  const [cash, setCash]       = useState('')
  const [loading, setLoading] = useState(false)

  async function handleOpen() {
    const kopecks = Math.round(parseFloat(cash || '0') * 100)
    setLoading(true)
    try {
      await shiftApi.open(kopecks)
      toast.success('Зміну відкрито')
      onOpened()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#1A1A1A] flex items-center justify-center">
      <div className="bg-[#2C2C2C] rounded-2xl p-10 w-full max-w-sm text-center border border-gray-700">
        <Zap size={40} className="text-yellow-400 mx-auto mb-4" />
        <h1 className="text-white text-2xl font-bold mb-1">Відкрити зміну</h1>
        <p className="text-gray-500 text-sm mb-6">Введіть початковий залишок готівки в касі</p>
        <input
          type="number" min="0" step="0.01" autoFocus
          value={cash}
          onChange={(e) => setCash(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleOpen() }}
          placeholder="0.00 ₴"
          className="w-full bg-[#1A1A1A] text-white text-2xl font-bold text-center rounded-xl px-4 py-4 border border-gray-700 focus:outline-none focus:border-yellow-400 mb-4"
        />
        <button onClick={handleOpen} disabled={loading} style={{ minHeight: 56 }}
          className="w-full bg-yellow-400 hover:bg-yellow-300 text-black font-bold text-lg rounded-xl py-4 disabled:opacity-50 transition-colors">
          {loading ? 'Відкриваємо...' : 'Відкрити зміну'}
        </button>
      </div>
    </div>
  )
}

export default function POSPage() {
  const { store, completeSale } = usePOS()
  const [payOpen, setPayOpen]           = useState(false)
  const [customerOpen, setCustomerOpen] = useState(false)
  const [closeOpen, setCloseOpen]       = useState(false)
  const [lastSale, setLastSale]         = useState<Sale | null>(null)

  const shift = store.currentShift

  if (!shift) {
    return (
      <OpenShiftScreen
        onOpened={() => {
          shiftApi.current().then(({ data }) => store.setCurrentShift(data))
        }}
      />
    )
  }

  async function handleConfirmPayment(method: 'cash' | 'card' | 'debt', cashReceived?: number) {
    const sale = await completeSale(method, { cashReceived })
    if (sale) {
      setLastSale(sale as Sale)
      setPayOpen(false)
    }
  }

  return (
    <div className="h-screen flex flex-col bg-[#1A1A1A] overflow-hidden">
      {/* Хедер */}
      <header className="bg-[#111] border-b border-gray-800 px-4 py-2 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Zap size={18} className="text-yellow-400" />
          <span className="text-white font-bold text-sm">Форсаж</span>
          <span className="text-gray-600 text-xs">|</span>
          <span className="text-green-400 text-xs font-medium">Зміна відкрита</span>
        </div>
        <div className="flex items-center gap-3">
          {lastSale && (
            <button onClick={printReceipt}
              className="flex items-center gap-1.5 text-gray-400 hover:text-white text-xs">
              <Printer size={14} />
              Друк чека
            </button>
          )}
          <span className="text-yellow-400 font-bold text-sm">{formatMoney(store.total)}</span>
          <button onClick={() => setCloseOpen(true)}
            className="flex items-center gap-1.5 text-gray-500 hover:text-gray-300 text-xs">
            <LogOut size={14} />
            Закрити зміну
          </button>
        </div>
      </header>

      {/* Основна панель POS */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 border-r border-gray-800 min-h-0">
          <SearchPanel />
        </div>
        <div className="w-80 min-h-0 flex flex-col">
          <ReceiptPanel
            onPay={() => setPayOpen(true)}
            onSelectCustomer={() => setCustomerOpen(true)}
            onClear={() => { if (store.items.length > 0) store.clearReceipt() }}
          />
        </div>
      </div>

      {/* Модалки */}
      <ShiftCloseModal
        open={closeOpen}
        shiftId={shift.id}
        onClose={() => setCloseOpen(false)}
        onClosed={() => {
          store.setCurrentShift(null)
          store.clearReceipt()
          setCloseOpen(false)
        }}
      />

      <PaymentModal
        open={payOpen}
        onClose={() => setPayOpen(false)}
        onConfirm={handleConfirmPayment}
      />

      <QuickCustomerModal
        open={customerOpen}
        onClose={() => setCustomerOpen(false)}
        onCreated={(c: Customer) => {
          store.setCustomer({ id: c.id, phone: c.phone, name: c.full_name, debtBalance: c.debt_balance })
        }}
      />

      {/* Прихований чек для друку */}
      {lastSale && <ReceiptPrint sale={lastSale} />}
    </div>
  )
}
