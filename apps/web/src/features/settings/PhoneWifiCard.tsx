import { useEffect, useState } from 'react'
import qrcode from 'qrcode-generator'
import { Smartphone } from 'lucide-react'
import { Button } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { desktopBridge, type DesktopPhoneAccess } from '@/lib/desktopBridge'
import { phoneQrText } from '@/lib/phoneLan/phoneLan'

/**
 * Головний ПК: «Телефони через Wi-Fi» (27.11.2026, слово власника: «якщо застосунок в одній мережі з головним ПК по Wi-Fi —
 * щоб можна було працювати без інтернету»). Власник вмикає й показує QR-код; телефон сканує його один раз.
 * Код лише відкриває канал — хто працює, визначає пароль працівника. «Новий код» відʼєднує всі телефони (загубили телефон).
 */
function qrSvg(text: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ cellSize: 5, margin: 2 })
}

export function PhoneWifiCard() {
  const lan = desktopBridge()?.lan
  const [state, setState] = useState<DesktopPhoneAccess | null>(null)
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState(false)
  useEffect(() => { void lan?.phoneAccess?.().then(setState).catch(() => setState(null)) }, [lan])
  if (!lan?.phoneAccess || !lan.setPhoneAccess || !state?.hub) return null

  const change = async (action: 'enable' | 'rotate' | 'disable') => {
    if (action === 'rotate' && !window.confirm('Новий код відʼєднає всі телефони — їх треба буде підключити знову. Продовжити?')) return
    setBusy(true)
    try { setState(await lan.setPhoneAccess!(action)); if (action !== 'disable') setShown(true) }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Не вдалося змінити доступ телефонів') }
    finally { setBusy(false) }
  }
  const address = state.addresses[0]
  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-white p-3 text-sm" data-phone-wifi>
      <p className="flex items-center gap-2 font-semibold text-gray-800"><Smartphone size={16} /> Телефони через Wi-Fi</p>
      <p className="mt-1 text-xs text-gray-600">Телефон у тій самій мережі Wi-Fi працює з цим ПК і без інтернету: каса, повернення, товари, клієнти, замовлення. Кожен працівник входить своїм паролем; права — як у вебі.</p>
      {!state.enabled ? (
        <Button type="button" className="mt-2" loading={busy} onClick={() => change('enable')}>Увімкнути й показати QR-код</Button>
      ) : (
        <div className="mt-2 space-y-2">
          {shown && address && state.key ? (
            <div className="flex flex-wrap items-start gap-3">
              <div className="rounded bg-white p-1" aria-label="QR-код для телефона" dangerouslySetInnerHTML={{ __html: qrSvg(phoneQrText({ host: address, port: state.port, key: state.key })) }} />
              <p className="max-w-xs text-xs text-gray-600">На телефоні: застосунок «Форсаж» → екран входу → «Через Wi-Fi» → «Сканувати QR-код». Адреса {address}:{state.port}.
                {state.addresses.length > 1 && ` Якщо не підключається, спробуйте іншу адресу цього ПК: ${state.addresses.slice(1).join(', ')}.`}</p>
            </div>
          ) : (
            <Button type="button" variant="secondary" onClick={() => setShown(true)} disabled={!address}>{address ? 'Показати QR-код' : 'Немає локальної мережі на цьому ПК'}</Button>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" loading={busy} onClick={() => change('rotate')}>Новий код (відʼєднати всі телефони)</Button>
            <Button type="button" variant="secondary" loading={busy} onClick={() => change('disable')}>Вимкнути</Button>
          </div>
        </div>
      )}
    </div>
  )
}
