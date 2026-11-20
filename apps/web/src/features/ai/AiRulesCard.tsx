import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { aiApi, type AiRule } from './aiApi'

/**
 * Пам'ять помічника: правила власника. Їх можна додати тут або в чаті словами
 * «Запам'ятай: …», «Забудь правило 2», «Які правила?».
 */
export function AiRulesCard({ canEdit }: { canEdit: boolean }) {
  const [rules, setRules] = useState<AiRule[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    aiApi.rules().then(({ data }) => { if (alive) setRules(data) }).catch(() => { if (alive) setLoadError(true) })
    return () => { alive = false }
  }, [])

  const add = async () => {
    const value = text.trim()
    if (value.length < 3) return
    setBusy(true)
    try { setRules((await aiApi.addRule(value)).data); setText('') }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Не вдалося зберегти правило') }
    finally { setBusy(false) }
  }
  const remove = async (rule: AiRule) => {
    if (!window.confirm(`Забути правило «${rule.text}»?`)) return
    setBusy(true)
    try { setRules((await aiApi.deleteRule(rule.id)).data) }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Не вдалося видалити правило') }
    finally { setBusy(false) }
  }

  return (
    <div className="border-t border-gray-100 pt-4 space-y-2">
      <p className="text-sm font-medium text-gray-700">Правила помічника (пам'ять)</p>
      <p className="text-xs text-gray-400">
        Помічник застосовує їх у чаті й під час розбору накладних. У чаті можна писати «Запам'ятай: …», «Забудь правило 2», «Які правила?».
        Правило з назвою постачальника діє лише на його накладні, наприклад: «Vitol: ціни в доларах, фото й опис брати з vitol.com.ua».
      </p>
      {loadError && <p className="text-xs text-amber-600">Правила зараз недоступні (немає зв'язку із сервером).</p>}
      {rules && rules.length === 0 && <p className="text-xs text-gray-500">Правил поки немає.</p>}
      {rules && rules.length > 0 && (
        <ol className="space-y-1">
          {rules.map((rule, index) => (
            <li key={rule.id} className="flex items-start gap-2 text-sm bg-gray-50 rounded-lg px-3 py-2">
              <span className="text-gray-400 w-6 shrink-0">{index + 1}.</span>
              <span className="flex-1 break-words">{rule.text}</span>
              {canEdit && (
                <button type="button" aria-label={`Забути правило ${index + 1}`} disabled={busy} onClick={() => void remove(rule)}
                  className="text-red-400 hover:text-red-600 p-1 cursor-pointer disabled:opacity-40">
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      {canEdit && !loadError && (
        <div className="flex gap-2">
          <input value={text} onChange={event => setText(event.target.value)} maxLength={500} aria-label="Нове правило помічника"
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void add() } }}
            placeholder="Наприклад: хомути класти в категорію «Кріплення»"
            className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
          <Button type="button" variant="secondary" onClick={() => void add()} loading={busy} disabled={text.trim().length < 3} icon={<Plus size={14} />}>
            Додати
          </Button>
        </div>
      )}
    </div>
  )
}
