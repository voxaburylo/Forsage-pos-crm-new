import { useEffect, useRef, useState } from 'react'
import { Check, Send, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import { ReplyText } from '@/features/ai/ReplyText'
import { errorText, siteCall, SITE_URL } from './siteGateway'
import { SITE_SETTING_FIELDS } from './SiteSimpleTabs'
import { SiteCategorySortPanel } from './SiteCategorySortPanel'
import { SiteTextJobPanel } from './SiteTextJobPanel'
import { applyArticle, applyForumPost, applyProductTexts, applySectionSeo, applySiteSeo, SEO_QUICK, seoHistory, type SeoAction, type SeoEntry } from './siteSeo'

/**
 * Вкладка «ШІ-помічник» розділу «Сайт» (26.11.2026, слово власника): той самий помічник, але тут він відповідає за SEO,
 * описи товарів, розділи каталогу, статті й форум. Читає сайт і каталог, готує пропозиції; на сайт записує власник однією
 * кнопкою. З 27.11.2026 тему чи відповідь на форумі програма публікує сама, від імені магазину.
 */
const STORE = 'forsage.site.seo.chat:v1'
interface Saved { entries: SeoEntry[]; outcome: Record<string, string> }
function load(): Saved {
  try { const saved = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Saved | null; if (saved && Array.isArray(saved.entries)) return { entries: saved.entries.slice(-40), outcome: saved.outcome ?? {} } } catch { /* без памʼяті */ }
  return { entries: [], outcome: {} }
}

export function SiteSeoAssistantTab() {
  const [saved] = useState(load)
  const [entries, setEntries] = useState<SeoEntry[]>(saved.entries)
  const [outcome, setOutcome] = useState<Record<string, string>>(saved.outcome)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [applying, setApplying] = useState('')
  const [progress, setProgress] = useState('')
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify({ entries: entries.slice(-40), outcome })) } catch { /* без памʼяті */ } }, [entries, outcome])
  useEffect(() => { bottom.current?.scrollIntoView?.({ block: 'end' }) }, [entries, sending])

  async function send(raw: string) {
    const message = raw.trim()
    if (!message || sending) return
    const history = seoHistory(entries, outcome)
    setEntries(current => [...current, { role: 'user', text: message }])
    setText(''); setSending(true)
    try {
      const answer = await api.post<{ data: { reply: string; actions: SeoAction[] } }>('/api/v1/site-admin/seo-chat', { message, history }, undefined, { silent: true, timeoutMs: 13 * 60_000 })
      setEntries(current => [...current, { role: 'model', text: answer.data.reply, actions: answer.data.actions }])
    } catch (reason) {
      setEntries(current => [...current, { role: 'model', text: errorText(reason, 'Зараз не вийшло відповісти. Спробуйте ще раз за хвилину.') }])
    } finally { setSending(false) }
  }

  async function confirm(action: SeoAction) {
    if (applying) return
    setApplying(action.id)
    try {
      if (action.kind === 'product_texts') {
        const result = await applyProductTexts(action.items, siteCall)
        setOutcome(current => ({ ...current, [action.id]: `записано на сайт ${result.done}` + (result.failed.length ? `, не вдалося ${result.failed.length}: ` + result.failed.slice(0, 5).map(row => `${row.item} — ${row.error}`).join('; ') : '') }))
        if (result.failed.length) toast.warning(`Записано ${result.done}, не вдалося ${result.failed.length}`); else toast.success(`Тексти на сайті: ${result.done}`)
      } else if (action.kind === 'article') {
        await applyArticle(action, siteCall)
        setOutcome(current => ({ ...current, [action.id]: 'статтю записано на сайт' })); toast.success('Статтю збережено на сайті')
      } else if (action.kind === 'section_seo') {
        const result = await applySectionSeo(action.items, siteCall, done => setProgress(`${done} з ${action.items.length}`))
        setOutcome(current => ({ ...current, [action.id]: `записано на сайт ${result.done}` + (result.failed.length ? `, не вдалося ${result.failed.length}: ` + result.failed.slice(0, 5).map(row => `${row.item} — ${row.error}`).join('; ') : '') }))
        if (result.failed.length) toast.warning(`Записано ${result.done}, не вдалося ${result.failed.length}`); else toast.success(`Розділи оновлено: ${result.done}`)
      } else if (action.kind === 'forum_post') {
        const url = await applyForumPost(action, siteCall)
        setOutcome(current => ({ ...current, [action.id]: action.post_kind === 'topic' ? 'тему опубліковано на форумі' + (url ? ': ' + url : '') : 'відповідь опубліковано на форумі' }))
        toast.success(action.post_kind === 'topic' ? 'Тему від магазину опубліковано' : 'Відповідь від магазину опубліковано')
      } else if (action.kind === 'site_seo') {
        await applySiteSeo(action, SITE_SETTING_FIELDS.map(field => field.key), siteCall)
        setOutcome(current => ({ ...current, [action.id]: 'записано на сайт' })); toast.success('Заголовок і опис сайту збережено')
      }
    } catch (reason) { toast.error(errorText(reason, 'Сайт не прийняв зміну')) } finally { setApplying(''); setProgress('') }
  }

  const busy = sending || Boolean(applying)
  return (
    <div className="flex min-h-[60vh] flex-col gap-3" data-site-seo>
      <SiteCategorySortPanel refresh={entries.length} />
      <SiteTextJobPanel refresh={entries.length} />
      {entries.length === 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-3 text-sm text-gray-700">
          <p className="font-semibold text-gray-900">Помічник із просування сайту</p>
          <p className="mt-1 text-xs text-gray-500">Пише описи й заголовки товарів для Google, статті, теми для форуму, перевіряє сторінки сайту. Нічого не змінює сам — ви підтверджуєте кнопкою. Почніть із готового завдання або напишіть своїми словами.</p>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5" data-site-seo-quick>
        {SEO_QUICK.map(item => <button key={item.label} type="button" disabled={busy} onClick={() => void send(item.text)}
          className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs text-gray-700 hover:border-gray-400 hover:bg-gray-50 disabled:opacity-50">{item.label}</button>)}
        {entries.length > 0 && <button type="button" disabled={busy} onClick={() => { if (window.confirm('Очистити розмову? Уже записане на сайт лишиться.')) { setEntries([]); setOutcome({}) } }}
          className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-gray-400 hover:text-gray-700"><Trash2 size={12} /> очистити</button>}
      </div>
      <div className="flex-1 space-y-3">
        {entries.map((entry, index) => (
          <div key={index} className={entry.role === 'user' ? 'ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl bg-yellow-100 px-3 py-2 text-sm text-gray-900' : 'max-w-[95%] space-y-2'}>
            {entry.role === 'user' ? entry.text : <div className="whitespace-pre-wrap rounded-2xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800" data-site-seo-reply><ReplyText text={entry.text} /></div>}
            {entry.actions?.map(action => (
              <SeoActionCard key={action.id} action={action} done={outcome[action.id]} busy={busy} loading={applying === action.id} progress={applying === action.id ? progress : ''}
                onConfirm={() => void confirm(action)}
                onReject={() => setOutcome(current => ({ ...current, [action.id]: 'власник відхилив' }))} />
            ))}
          </div>
        ))}
        {sending && <p role="status" className="text-sm text-gray-500">Помічник читає сайт і пише… це може тривати хвилину-дві.</p>}
        <div ref={bottom} />
      </div>
      <form className="flex items-end gap-2 rounded-xl border border-gray-200 bg-white p-2" data-site-seo-form onSubmit={event => { event.preventDefault(); void send(text) }}>
        <textarea value={text} onChange={event => setText(event.target.value)} rows={2} maxLength={8000} disabled={sending} aria-label="Завдання помічнику"
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(text) } }}
          placeholder="Напр.: напиши описи для моторних олив Castrol у наявності" className="min-h-[44px] flex-1 resize-y rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-yellow-400" />
        <Button type="submit" loading={sending} disabled={!text.trim() || Boolean(applying)} icon={<Send size={14} />}>Надіслати</Button>
      </form>
    </div>
  )
}

export function SeoActionCard({ action, done, busy, loading, progress, onConfirm, onReject }: {
  action: SeoAction; done?: string; busy: boolean; loading: boolean; progress: string; onConfirm: () => void; onReject: () => void
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 text-sm" data-site-seo-action={action.kind}>
      <p className="font-semibold text-gray-900">{action.title}</p>
      {action.kind === 'product_texts' && (
        <ul className="mt-2 max-h-80 space-y-2 overflow-y-auto">
          {action.items.map(item => (
            <li key={item.product_id} className="rounded-lg border border-gray-100 bg-white p-2 text-xs">
              <p className="font-medium text-gray-900">{item.name}{item.sku ? <span className="font-normal text-gray-400"> · арт. {item.sku}</span> : null}</p>
              {item.seo_title && <p className="mt-1 text-blue-800">{item.seo_title}</p>}
              {item.seo_description && <p className="text-gray-600">{item.seo_description}</p>}
              {item.description && <p className="mt-1 whitespace-pre-line text-gray-800">{item.description}</p>}
              {item.seo_keywords && <p className="mt-1 text-gray-500">Ключові слова: {item.seo_keywords}</p>}
              {item.notes.map(note => <p key={note} className="mt-0.5 text-gray-500">Зверніть увагу: {note}</p>)}
            </li>
          ))}
          {action.refused.length > 0 && <li className="text-xs text-gray-500">Не взято {action.refused.length}: {action.refused.slice(0, 3).map(row => row.reason).join('; ')}</li>}
        </ul>
      )}
      {action.kind === 'article' && <p className="mt-2 max-h-80 overflow-y-auto whitespace-pre-line rounded-lg border border-gray-100 bg-white p-2 text-xs text-gray-800">{action.content}</p>}
      {action.kind === 'site_seo' && <div className="mt-2 rounded-lg border border-gray-100 bg-white p-2 text-xs">
        {action.seo_title && <p className="text-blue-800">{action.seo_title}</p>}{action.seo_description && <p className="text-gray-600">{action.seo_description}</p>}</div>}
      {action.kind === 'forum_post' && <>
        <p className="mt-1 text-xs text-gray-500">{action.post_kind === 'topic' ? `Нова тема від магазину в розділі «${action.section}».` : `Відповідь від магазину в темі «${action.topic_title}».`} Після підтвердження зʼявиться на <a className="text-blue-700 underline" href={SITE_URL + '/forum'} target="_blank" rel="noopener noreferrer">форумі сайту</a>.</p>
        <p className="mt-2 max-h-80 overflow-y-auto whitespace-pre-line rounded-lg border border-gray-100 bg-white p-2 text-xs text-gray-800">{action.body}</p></>}
      {action.kind === 'section_seo' && (
        <ul className="mt-2 max-h-80 space-y-2 overflow-y-auto">
          {action.items.map(item => (
            <li key={item.id} className="rounded-lg border border-gray-100 bg-white p-2 text-xs">
              <p className="font-medium text-gray-900">{item.name}</p>
              {item.seo_title && <p className="mt-1 text-blue-800">{item.seo_title}</p>}
              {item.seo_description && <p className="text-gray-600">{item.seo_description}</p>}
              {item.description && <p className="mt-1 whitespace-pre-line text-gray-800">{item.description}</p>}
              {item.faq?.map(row => <p key={row.q} className="mt-1 text-gray-700"><span className="font-medium">{row.q}</span> {row.a}</p>)}
              {item.notes.map(note => <p key={note} className="mt-0.5 text-gray-500">Зверніть увагу: {note}</p>)}
            </li>
          ))}
          {action.refused.length > 0 && <li className="text-xs text-gray-500">Не взято {action.refused.length}: {action.refused.slice(0, 3).map(row => row.reason).join('; ')}</li>}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {done
            ? <p className="flex items-center gap-1 text-xs font-semibold text-emerald-700"><Check size={14} /> {done}</p>
            : <>
              <Button type="button" size="sm" icon={<Check size={14} />} loading={loading} disabled={busy && !loading} onClick={onConfirm} data-site-seo-confirm>
                {action.kind === 'product_texts' || action.kind === 'section_seo' ? `Підтвердити (${action.items.length})` : action.kind === 'forum_post' ? 'Опублікувати на форумі' : 'Підтвердити'}</Button>
              <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onReject}>Відхилити</Button>
              {progress && <span role="status" className="text-xs text-gray-500">{progress}</span>}
            </>}
      </div>
    </div>
  )
}
