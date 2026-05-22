import { useState, useEffect } from 'react'
import { Banknote, CreditCard, BookOpen, Star, SplitSquareHorizontal, Smartphone, Receipt, Loader2 } from 'lucide-react'
import { usePOSStore } from '@/stores/posStore'
import { api } from '@/lib/api'
import { formatMoney } from '@/lib/utils'

interface SplitAmounts {
  cash_amount: number
  card_amount: number
}

interface Props {
  open: boolean
  onClose: () => void
  onConfirm: (method: 'cash' | 'card' | 'debt' | 'mixed' | 'transfer', cashReceived?: number, bonusRedeemed?: number, split?: SplitAmounts, isFiscal?: boolean, terminalAuthCode?: string) => Promise<void>
}

type Method = 'cash' | 'card' | 'debt' | 'mixed' | 'transfer'

const FISCAL_KEY = 'forsage_pos_fiscal_enabled'

const METHODS: { id: Method; label: string; icon: React.ReactNode; color: string; requireCustomer?: boolean }[] = [
  { id: 'cash',     label: 'Готівка',         icon: <Banknote size={20} />,                 color: 'bg-green-500 hover:bg-green-400' },
  { id: 'card',     label: 'Термінал',        icon: <CreditCard size={20} />,               color: 'bg-blue-500 hover:bg-blue-400' },
  { id: 'transfer', label: 'Переказ на карту', icon: <Smartphone size={20} />,              color: 'bg-cyan-500 hover:bg-cyan-400' },
  { id: 'debt',     label: 'Борг',            icon: <BookOpen size={20} />,                 color: 'bg-red-500 hover:bg-red-400', requireCustomer: true },
  { id: 'mixed',    label: 'Split',           icon: <SplitSquareHorizontal size={20} />,    color: 'bg-purple-500 hover:bg-purple-400' },
]

export function PaymentModal({ open, onClose, onConfirm }: Props) {
  const store             = usePOSStore()
  const [method, setMethod]         = useState<Method>('cash')
  const [cashInput, setCash]        = useState('')
  const [loading, setLoading]       = useState(false)
  const [terminalStep, setTerminalStep] = useState<'none' | 'waiting_auth'>('none')
  const [terminalAuthCode, setTerminalAuthCode] = useState('')
  const [bonusBalance, setBonusBalance]   = useState(0)
  const [maxBonus, setMaxBonus]           = useState(0)
  const [bonusInput, setBonusInput]       = useState('')
  const [loyaltyEnabled, setLoyaltyEnabled] = useState(false)
  const [fiscal, setFiscal] = useState(() => localStorage.getItem(FISCAL_KEY) !== 'false')
  const [splitCash, setSplitCash] = useState('')

  // Авто-фіскалізація при оплаті карткою (обов'язково за законом)
  useEffect(() => {
    if (method === 'card') setFiscal(true)
  }, [method])

  useEffect(() => {
    if (!open || !store.customer) {
      setBonusBalance(0); setMaxBonus(0); setBonusInput(''); setLoyaltyEnabled(false)
      return
    }
    api.get<{ data: { balance: number; max_redeem: number } }>(
      '/api/v1/loyalty/customer/' + store.customer.id + '/max-redeem?total=' + store.total
    ).then((res) => {
      setBonusBalance(res.data.balance)
      setMaxBonus(res.data.max_redeem)
      setLoyaltyEnabled(res.data.max_redeem > 0 || res.data.balance > 0)
    }).catch(() => {})
  }, [open, store.customer, store.total])

  // Обчислення сум (потрібні і для діалогу термінала, і для основного UI)
  const _bonusRedeemed = Math.min(
    Math.round(parseFloat(bonusInput || '0') * 100),
    maxBonus, bonusBalance,
  )
  const _toPay = Math.max(0, store.total - _bonusRedeemed)

  // Діалог: проведіть оплату на терміналі і введіть код авторизації
  if (terminalStep === 'waiting_auth') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/70" />
        <div className="relative bg-[#1A1A1A] rounded-2xl border border-gray-700 w-full max-w-sm mx-4 p-6 space-y-5">
          <div className="text-center">
            <CreditCard size={40} className="text-blue-400 mx-auto mb-3" />
            <h3 className="text-white text-lg font-bold">Проведіть оплату на терміналі</h3>
            <p className="text-yellow-400 text-3xl font-bold mt-2">{formatMoney(_toPay)}</p>
          </div>

          <div className="bg-[#2C2C2C] rounded-xl p-4 text-sm text-gray-300 space-y-1">
            <p>1. Введіть суму на терміналі ПриватБанку</p>
            <p>2. Клієнт прикладає картку / телефон</p>
            <p>3. Після успішної оплати введіть код авторизації з чека термінала</p>
          </div>

          <div>
            <label className="text-gray-400 text-xs mb-1 block">Код авторизації (з чека термінала)</label>
            <input
              type="text"
              autoFocus
              value={terminalAuthCode}
              onChange={(e) => setTerminalAuthCode(e.target.value.toUpperCase().replace(/\s/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmTerminalPayment() }}
              maxLength={12}
              placeholder="наприклад: 123456"
              className="w-full bg-[#2C2C2C] text-white text-xl font-mono text-center rounded-xl px-4 py-3 border border-gray-600 focus:outline-none focus:border-blue-400"
            />
            <p className="text-gray-500 text-xs mt-1 text-center">Залиште порожнім якщо код не потрібен</p>
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => { setTerminalStep('none'); setTerminalAuthCode(''); setLoading(false) }}
              className="flex-1 py-3 rounded-xl bg-[#2C2C2C] text-gray-300 font-semibold hover:bg-gray-700"
            >
              Скасувати
            </button>
            <button
              onClick={confirmTerminalPayment}
              disabled={loading}
              className="flex-1 py-3 rounded-xl bg-blue-500 hover:bg-blue-400 text-white font-bold disabled:opacity-40"
            >
              {loading ? <Loader2 size={16} className="animate-spin mx-auto" /> : 'Підтвердити оплату'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!open) return null

  const bonusRedeemed = Math.min(
    Math.round(parseFloat(bonusInput || '0') * 100), maxBonus, bonusBalance,
  )
  const toPay        = Math.max(0, store.total - bonusRedeemed)
  const cashReceived = Math.round(parseFloat(cashInput || '0') * 100)
  const change       = Math.max(0, cashReceived - toPay)
  const cashValid    = method !== 'cash' || cashReceived >= toPay
  const debtOk       = method !== 'debt' || !!store.customer

  const splitCashKopecks = Math.round(parseFloat(splitCash || '0') * 100)
  const splitCardKopecks = Math.max(0, toPay - splitCashKopecks)
  const splitValid       = method !== 'mixed' || (splitCashKopecks > 0 && splitCashKopecks < toPay)

  function handleFiscalToggle() {
    const next = !fiscal
    setFiscal(next)
    localStorage.setItem(FISCAL_KEY, next ? 'true' : 'false')
  }

  async function handleConfirm() {
    if (!cashValid || !debtOk || !splitValid) return

    // Картка або Split → спочатку показуємо діалог термінала
    if (method === 'card' || (method === 'mixed' && splitCardKopecks > 0)) {
      setLoading(true)
      setTerminalStep('waiting_auth')
      return
    }

    await submitSale()
  }

  async function confirmTerminalPayment() {
    setLoading(true)
    await submitSale(terminalAuthCode || undefined)
    setTerminalStep('none')
    setTerminalAuthCode('')
  }

  async function submitSale(authCode?: string) {
    try {
      if (method === 'mixed') {
        await onConfirm('mixed', undefined, bonusRedeemed || undefined, { cash_amount: splitCashKopecks, card_amount: splitCardKopecks }, fiscal, authCode)
      } else {
        await onConfirm(method, method === 'cash' ? cashReceived : undefined, bonusRedeemed || undefined, undefined, fiscal, authCode)
      }
    } finally {
      setLoading(false)
      setCash(''); setMethod('cash'); setBonusInput(''); setSplitCash('')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative bg-[#1A1A1A] rounded-2xl border border-gray-700 w-full max-w-sm mx-4 overflow-hidden">

        <div className="px-6 py-4 border-b border-gray-800">
          <p className="text-gray-400 text-sm">До оплати</p>
          <p className="text-white text-4xl font-bold">{formatMoney(toPay)}</p>
          {bonusRedeemed > 0 && (
            <p className="text-yellow-400 text-xs mt-1">з них бонусами: {formatMoney(bonusRedeemed)}</p>
          )}
          {store.customer && (
            <p className="text-gray-400 text-sm mt-1">{store.customer.name ?? store.customer.phone}</p>
          )}
        </div>

        <div className="p-6 space-y-4">
          {/* Бонуси */}
          {loyaltyEnabled && store.customer && (
            <div className="bg-yellow-900/20 border border-yellow-600/30 rounded-xl px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Star size={14} className="text-yellow-400" />
                  <span className="text-yellow-400 text-xs font-medium">Бонуси клієнта</span>
                </div>
                <span className="text-yellow-300 text-sm font-bold">{formatMoney(bonusBalance)}</span>
              </div>
              {maxBonus > 0 && (
                <div>
                  <label className="text-gray-400 text-xs mb-1 block">
                    Списати бонусів (макс {formatMoney(Math.min(bonusBalance, maxBonus))})
                  </label>
                  <input type="number" min="0" step="0.01"
                    max={(Math.min(bonusBalance, maxBonus) / 100).toFixed(2)}
                    value={bonusInput} onChange={(e) => setBonusInput(e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-[#2C2C2C] text-yellow-300 text-lg font-bold text-center rounded-lg px-3 py-2 border border-yellow-600/30 focus:outline-none focus:border-yellow-400" />
                </div>
              )}
            </div>
          )}

          {/* Вибір методу 3+2 */}
          <div className="grid grid-cols-3 gap-2">
            {METHODS.slice(0, 3).map((m) => (
              <button key={m.id} onClick={() => { if (!m.requireCustomer || store.customer) setMethod(m.id) }}
                style={{ minHeight: 52 }}
                className={'flex flex-col items-center justify-center gap-1 rounded-xl text-white text-[10px] font-semibold transition-all leading-tight ' +
                  (method === m.id ? m.color + ' ring-2 ring-white/30' : 'bg-[#2C2C2C] hover:bg-gray-700') +
                  (m.requireCustomer && !store.customer ? ' opacity-40 cursor-not-allowed' : '')}>
                {m.icon}{m.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {METHODS.slice(3).map((m) => (
              <button key={m.id} onClick={() => { if (!m.requireCustomer || store.customer) setMethod(m.id) }}
                style={{ minHeight: 44 }}
                className={'flex items-center justify-center gap-1.5 rounded-xl text-white text-xs font-semibold transition-all ' +
                  (method === m.id ? m.color + ' ring-2 ring-white/30' : 'bg-[#2C2C2C] hover:bg-gray-700') +
                  (m.requireCustomer && !store.customer ? ' opacity-40 cursor-not-allowed' : '')}>
                {m.icon}{m.label}
              </button>
            ))}
          </div>

          {/* Cash input */}
          {method === 'cash' && (
            <div>
              <label className="text-gray-400 text-xs mb-1 block">Отримано готівки (₴)</label>
              <input type="number" min="0" step="0.01" autoFocus value={cashInput}
                onChange={(e) => setCash(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm() }}
                placeholder="0.00"
                className="w-full bg-[#2C2C2C] text-white text-2xl font-bold text-center rounded-xl px-4 py-3 border border-gray-700 focus:outline-none focus:border-yellow-400" />
              {cashReceived >= toPay && cashReceived > 0 && <p className="text-green-400 text-center text-sm mt-2 font-medium">Решта: {formatMoney(change)}</p>}
              {cashInput && cashReceived < toPay && <p className="text-red-400 text-center text-sm mt-2">Не вистачає: {formatMoney(toPay - cashReceived)}</p>}
            </div>
          )}

          {/* Split */}
          {method === 'mixed' && (
            <div>
              <label className="text-gray-400 text-xs mb-1 block">Готівка (₴)</label>
              <input type="number" min="0.01" step="0.01" autoFocus value={splitCash}
                onChange={(e) => setSplitCash(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm() }}
                placeholder="0.00"
                className="w-full bg-[#2C2C2C] text-white text-2xl font-bold text-center rounded-xl px-4 py-3 border border-gray-700 focus:outline-none focus:border-purple-500" />
              {splitCashKopecks > 0 && splitCashKopecks < toPay && (
                <div className="mt-3 space-y-1">
                  <div className="flex justify-between text-sm px-1">
                    <span className="text-green-400">Готівка:</span>
                    <span className="text-green-400 font-bold">{formatMoney(splitCashKopecks)}</span>
                  </div>
                  <div className="flex justify-between text-sm px-1">
                    <span className="text-blue-400">Картка:</span>
                    <span className="text-blue-400 font-bold">{formatMoney(splitCardKopecks)}</span>
                  </div>
                  <div className="border-t border-gray-700 pt-1 flex justify-between text-sm px-1">
                    <span className="text-white">Разом:</span>
                    <span className="text-white font-bold">{formatMoney(splitCashKopecks + splitCardKopecks)}</span>
                  </div>
                </div>
              )}
              {splitCashKopecks >= toPay && <p className="text-yellow-400 text-center text-sm mt-2">Сума готівки покриває весь чек. Використайте "Готівка".</p>}
            </div>
          )}

          {/* Debt */}
          {method === 'debt' && !store.customer && (
            <div className="bg-red-900/30 border border-red-500/50 rounded-xl px-4 py-3">
              <p className="text-red-400 text-sm text-center">Вкажіть клієнта в чеку для продажу в борг</p>
            </div>
          )}

          {/* Fiscal toggle (for cash/card/transfer/mixed) */}
          {method !== 'debt' && (
            <div className="py-1 px-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Receipt size={16} className="text-gray-400" />
                  <span className="text-gray-300 text-sm">🧾 Фіскальний чек</span>
                </div>
                <label className={`relative inline-flex items-center ${method === 'card' ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                  <input type="checkbox" checked={fiscal}
                    onChange={method === 'card' ? undefined : handleFiscalToggle}
                    disabled={method === 'card'}
                    className="sr-only peer" />
                  <div className={`w-9 h-5 rounded-full after:content-[''] after:absolute after:top-0.5 after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full ${
                    method === 'card'
                      ? 'bg-yellow-400 peer-checked:bg-yellow-400 opacity-80'
                      : 'bg-gray-600 peer-checked:bg-yellow-400'
                  }`} />
                </label>
              </div>
              {method === 'card' && (
                <p className="text-yellow-500/70 text-[10px] mt-1 ml-0.5">
                  ⚖️ Оплата терміналом обов'язково фіскалізується
                </p>
              )}
            </div>
          )}

          {/* Кнопки */}
          <div className="flex gap-3">
            <button onClick={onClose}
              className="flex-1 py-4 rounded-xl bg-[#2C2C2C] text-gray-300 font-semibold hover:bg-gray-700 transition-colors">Скасувати</button>
            <button onClick={handleConfirm}
              disabled={loading || !cashValid || !debtOk || !splitValid}
              style={{ minHeight: 56 }}
              className="flex-1 py-4 rounded-xl bg-yellow-400 text-black font-bold hover:bg-yellow-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              {loading ? 'Обробка...' : 'ПІДТВЕРДИТИ'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
