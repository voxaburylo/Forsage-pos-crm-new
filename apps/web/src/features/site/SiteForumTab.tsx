import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, EyeOff, ImagePlus, Lock, Pin, Plus, Search } from 'lucide-react'
import { Button, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { errorText, SITE_URL, siteCall, useSiteData } from './siteGateway'
import { forumStatsLine, forumTextProblem, FORUM_LIMITS, uploadForumPhotos, when, type ForumPost, type ForumSection, type ForumTopic, type ForumTopicRow } from './siteForum'

/**
 * Вкладка «Форум» розділу «Сайт» (27.11.2026): теми, перегляд, нова тема й відповідь від магазину, сховати, закріпити,
 * закрити, видалити, розділи, статистика за тиждень. Видалення — єдине місце з підтвердженням: його не повернути.
 */
const input = 'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-yellow-400'
const chip = 'rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600'

export function SiteForumTab() {
  const sections = useSiteData<ForumSection[]>('forum.sections.list')
  const [section, setSection] = useState('')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [only, setOnly] = useState<'' | 'hidden' | 'shop'>('')
  const params = useMemo(() => ({ limit: 50, ...(section ? { section } : {}), ...(query ? { search: query } : {}), ...(only === 'hidden' ? { hidden: true } : {}), ...(only === 'shop' ? { from_shop: true } : {}) }), [section, query, only])
  const topics = useSiteData<ForumTopicRow[]>('forum.topics.list', params)
  const stats = useSiteData<unknown>('forum.stats', { days: 7 })
  const [openId, setOpenId] = useState<string | number | null>(null)
  const [creating, setCreating] = useState(false)
  const [managing, setManaging] = useState(false)
  const list = sections.data ?? []
  return (
    <div className="space-y-3" data-site-forum>
      {forumStatsLine(stats.data, 7) && <p className="text-xs text-gray-500" data-site-forum-stats>{forumStatsLine(stats.data, 7)}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Розділ форуму" value={section} onChange={event => setSection(event.target.value)} className="rounded-lg border border-gray-200 bg-white px-2 py-2 text-sm">
          <option value="">Усі розділи</option>
          {list.map(item => <option key={String(item.id)} value={item.slug}>{item.name}</option>)}
        </select>
        <form className="flex min-w-[12rem] flex-1 items-center gap-1" onSubmit={event => { event.preventDefault(); setQuery(search.trim()) }}>
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Пошук у темах" aria-label="Пошук у темах" className={input} />
          <Button type="submit" size="sm" variant="secondary" icon={<Search size={14} />}>Знайти</Button>
        </form>
        <select aria-label="Які теми" value={only} onChange={event => setOnly(event.target.value as typeof only)} className="rounded-lg border border-gray-200 bg-white px-2 py-2 text-sm">
          <option value="">Усі теми</option><option value="shop">Теми магазину</option><option value="hidden">Сховані</option>
        </select>
        <Button size="sm" icon={<Plus size={14} />} onClick={() => setCreating(true)} data-site-forum-new>Нова тема</Button>
        <Button size="sm" variant="ghost" onClick={() => setManaging(true)}>Розділи</Button>
      </div>
      {topics.error && <p role="alert" className="text-sm text-gray-600">{topics.error} <button type="button" className="underline" onClick={() => void topics.reload()}>Повторити</button></p>}
      {topics.loading && !topics.data && <p role="status" className="text-sm text-gray-500">Завантажуємо теми…</p>}
      <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white" data-site-forum-topics>
        {(topics.data ?? []).map(topic => (
          <li key={String(topic.id)}>
            <button type="button" onClick={() => setOpenId(topic.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-gray-50">
              <span className="min-w-0 flex-1 text-sm font-medium text-gray-900">{topic.title}</span>
              <TopicBadges topic={topic} />
              <span className="text-xs text-gray-500">{[topic.section, topic.author_name, `${topic.replies_count ?? 0} відп.`, `${topic.views ?? 0} перегл.`, when(topic.last_reply_at)].filter(Boolean).join(' · ')}</span>
            </button>
          </li>
        ))}
        {topics.data && !topics.data.length && <li className="px-3 py-8 text-center text-sm text-gray-400">Тем не знайдено</li>}
      </ul>
      {openId !== null && <TopicModal id={openId} onClose={() => { setOpenId(null); void topics.reload() }} />}
      {creating && <NewTopicModal sections={list} initial={section} onClose={created => { setCreating(false); if (created) void topics.reload() }} />}
      {managing && <SectionsModal sections={list} onClose={() => { setManaging(false); void sections.reload() }} />}
    </div>
  )
}

function TopicBadges({ topic }: { topic: ForumTopicRow }) {
  return <span className="flex gap-1">
    {topic.is_shop && <span className={chip}>магазин</span>}
    {topic.is_pinned && <span className={chip}><Pin size={10} className="inline" /> закріплена</span>}
    {topic.is_locked && <span className={chip}><Lock size={10} className="inline" /> закрита</span>}
    {topic.is_hidden && <span className={chip}><EyeOff size={10} className="inline" /> схована</span>}
  </span>
}

/** Вибір фото з показом, скільки вибрано. */
function PhotoPicker({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
      <ImagePlus size={14} /> {files.length ? `Фото: ${files.length}` : 'Додати фото'}
      <input type="file" accept="image/*" multiple className="hidden" onChange={event => onChange(Array.from(event.target.files ?? []).filter(file => file.type.startsWith('image/')).slice(0, FORUM_LIMITS.photos))} />
    </label>
  )
}

function Images({ urls }: { urls?: string[] | null }) {
  if (!urls?.length) return null
  return <div className="mt-2 flex flex-wrap gap-2">{urls.map(url => <a key={url} href={url} target="_blank" rel="noopener noreferrer"><img src={url} alt="" loading="lazy" className="h-20 w-20 rounded-lg object-cover" /></a>)}</div>
}

function TopicModal({ id, onClose }: { id: string | number; onClose: () => void }) {
  const [topic, setTopic] = useState<ForumTopic | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [reply, setReply] = useState('')
  const [replyTo, setReplyTo] = useState<ForumPost | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const load = async () => { try { setTopic(await siteCall<ForumTopic>('forum.topic.get', { id })); setError('') } catch (reason) { setError(errorText(reason, 'Не вдалося відкрити тему')) } }
  useEffect(() => { void load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  async function act(key: string, run: () => Promise<unknown>, done?: string, close = false) {
    setBusy(key)
    try { await run(); if (done) toast.success(done); if (close) onClose(); else await load() } catch (reason) { toast.error(errorText(reason)) } finally { setBusy('') }
  }
  const update = (key: string, patch: Record<string, unknown>, done: string) => act(key, () => siteCall('forum.topics.update', { id, ...patch }), done)
  async function send() {
    const problem = forumTextProblem('reply', '', reply)
    if (problem) { toast.warning(problem); return }
    await act('reply', async () => {
      const images = await uploadForumPhotos(files)
      await siteCall('forum.posts.create', { topic_id: id, body: reply.trim(), ...(replyTo ? { parent_id: replyTo.id } : {}), ...(images.length ? { images } : {}) })
      setReply(''); setFiles([]); setReplyTo(null)
    }, 'Відповідь від магазину опубліковано')
  }
  return (
    <Modal open onClose={onClose} title={topic?.title ?? 'Тема форуму'} size="xl">
      <div className="space-y-3" data-site-forum-topic>
        {error && <p role="alert" className="text-sm text-gray-600">{error}</p>}
        {!topic && !error && <p role="status" className="text-sm text-gray-500">Завантажуємо…</p>}
        {topic && <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <span>{[topic.section, topic.author_name, when(topic.created_at)].filter(Boolean).join(' · ')}</span><TopicBadges topic={topic} />
            {topic.url && <a href={topic.url.startsWith('http') ? topic.url : SITE_URL + topic.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-700 underline"><ExternalLink size={12} /> на сайті</a>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="secondary" loading={busy === 'pin'} onClick={() => void update('pin', { pinned: !topic.is_pinned }, topic.is_pinned ? 'Відкріплено' : 'Закріплено вгорі розділу')}>{topic.is_pinned ? 'Відкріпити' : 'Закріпити'}</Button>
            <Button size="sm" variant="secondary" loading={busy === 'lock'} onClick={() => void update('lock', { locked: !topic.is_locked }, topic.is_locked ? 'Тему відкрито для відповідей' : 'Тему закрито для відповідей')}>{topic.is_locked ? 'Відкрити для відповідей' : 'Закрити для відповідей'}</Button>
            <Button size="sm" variant="secondary" loading={busy === 'hide'} onClick={() => void update('hide', { hidden: !topic.is_hidden }, topic.is_hidden ? 'Тему знову видно на сайті' : 'Тему сховано із сайту')}>{topic.is_hidden ? 'Показати на сайті' : 'Сховати'}</Button>
            <Button size="sm" variant="ghost" loading={busy === 'delete'} onClick={() => { if (window.confirm('Видалити тему разом з усіма відповідями? Повернути не вийде. Якщо є сумнів — краще «Сховати».')) void act('delete', () => siteCall('forum.topics.delete', { id }), 'Тему видалено', true) }}>Видалити</Button>
          </div>
          <div className="rounded-lg border border-gray-100 bg-gray-50/60 p-3 text-sm"><p className="whitespace-pre-line text-gray-800">{topic.body}</p><Images urls={topic.images} /></div>
          <ul className="space-y-2">
            {(topic.posts ?? []).map(post => (
              <li key={String(post.id)} className={`rounded-lg border border-gray-100 p-3 text-sm ${post.parent_id ? 'ml-6' : ''} ${post.is_hidden ? 'opacity-60' : ''}`}>
                <p className="text-xs text-gray-500">{post.author_name ?? 'Гість'}{post.is_shop ? ' · магазин' : ''} · {when(post.created_at)}{post.is_hidden ? ' · сховано' : ''}</p>
                <p className="mt-1 whitespace-pre-line text-gray-800">{post.body}</p><Images urls={post.images} />
                <div className="mt-1.5 flex gap-3 text-xs">
                  <button type="button" className="text-blue-700 underline" onClick={() => setReplyTo(post)}>Відповісти</button>
                  <button type="button" className="text-gray-500 underline" onClick={() => void act('ph' + post.id, () => siteCall('forum.posts.update', { id: post.id, hidden: !post.is_hidden }), post.is_hidden ? 'Повідомлення знову видно' : 'Повідомлення сховано')}>{post.is_hidden ? 'Показати' : 'Сховати'}</button>
                  <button type="button" className="text-gray-500 underline" onClick={() => { if (window.confirm('Видалити це повідомлення назавжди?')) void act('pd' + post.id, () => siteCall('forum.posts.delete', { id: post.id }), 'Повідомлення видалено') }}>Видалити</button>
                </div>
              </li>
            ))}
          </ul>
          <div className="space-y-2 border-t border-gray-100 pt-3">
            <p className="text-xs text-gray-500">Відповідь від магазину («Форсаж (магазин)»){replyTo ? <> — на повідомлення {replyTo.author_name ?? 'гостя'} <button type="button" className="underline" onClick={() => setReplyTo(null)}>скасувати</button></> : null}</p>
            <textarea value={reply} onChange={event => setReply(event.target.value)} rows={4} maxLength={FORUM_LIMITS.body} placeholder="Корисно й по суті. Абзаци — через порожній рядок." className={input} aria-label="Відповідь від магазину" />
            <div className="flex flex-wrap items-center gap-2"><PhotoPicker files={files} onChange={setFiles} /><Button size="sm" loading={busy === 'reply'} disabled={!reply.trim()} onClick={() => void send()} data-site-forum-reply>Опублікувати відповідь</Button></div>
          </div>
        </>}
      </div>
    </Modal>
  )
}

function NewTopicModal({ sections, initial, onClose }: { sections: ForumSection[]; initial: string; onClose: (created: boolean) => void }) {
  const [section, setSection] = useState(initial)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [pinned, setPinned] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  async function create() {
    const problem = forumTextProblem('topic', title, body, section)
    if (problem) { toast.warning(problem); return }
    setBusy(true)
    try {
      const images = await uploadForumPhotos(files)
      await siteCall('forum.topics.create', { section, title: title.trim(), body: body.trim(), ...(images.length ? { images } : {}), ...(pinned ? { pinned: true } : {}) })
      toast.success('Тему від магазину опубліковано'); onClose(true)
    } catch (reason) { toast.error(errorText(reason)) } finally { setBusy(false) }
  }
  return (
    <Modal open onClose={() => { if (!busy) onClose(false) }} title="Нова тема від магазину" size="lg">
      <div className="space-y-3" data-site-forum-create>
        <select aria-label="Розділ" value={section} onChange={event => setSection(event.target.value)} className={input}>
          <option value="">Виберіть розділ…</option>{sections.map(item => <option key={String(item.id)} value={item.slug}>{item.name}</option>)}
        </select>
        <input value={title} onChange={event => setTitle(event.target.value)} maxLength={FORUM_LIMITS.title} placeholder="Заголовок — так, як людина шукала б у Google" className={input} aria-label="Заголовок теми" />
        <textarea value={body} onChange={event => setBody(event.target.value)} rows={10} maxLength={FORUM_LIMITS.body} placeholder="Текст теми. Абзаци — через порожній рядок. Без вигаданих відгуків і діалогів." className={input} aria-label="Текст теми" />
        <div className="flex flex-wrap items-center gap-3">
          <PhotoPicker files={files} onChange={setFiles} />
          <label className="flex items-center gap-1.5 text-xs text-gray-600"><input type="checkbox" checked={pinned} onChange={event => setPinned(event.target.checked)} /> закріпити вгорі розділу</label>
          <Button className="ml-auto" loading={busy} onClick={() => void create()}>Опублікувати</Button>
        </div>
      </div>
    </Modal>
  )
}

function SectionsModal({ sections, onClose }: { sections: ForumSection[]; onClose: () => void }) {
  const [rows, setRows] = useState(sections)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState('')
  const reload = async () => { try { setRows(await siteCall<ForumSection[]>('forum.sections.list')) } catch { /* лишаємо як було */ } }
  async function act(key: string, run: () => Promise<unknown>, done: string) {
    setBusy(key)
    try { await run(); toast.success(done); await reload() } catch (reason) { toast.error(errorText(reason)) } finally { setBusy('') }
  }
  return (
    <Modal open onClose={onClose} title="Розділи форуму" size="md">
      <div className="space-y-3" data-site-forum-sections>
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
          {rows.map(row => (
            <li key={String(row.id)} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">{row.parent_id ? '— ' : ''}{row.name}</span>
              <button type="button" className="text-xs text-blue-700 underline" onClick={() => { const next = window.prompt('Нова назва розділу', row.name)?.trim(); if (next && next !== row.name) void act('r' + row.id, () => siteCall('forum.sections.upsert', { id: row.id, name: next }), 'Розділ перейменовано') }}>перейменувати</button>
              <button type="button" className="text-xs text-gray-500 underline" disabled={busy === 'd' + row.id} onClick={() => { if (window.confirm(`Видалити розділ «${row.name}»? Сайт дозволяє видалити лише порожній розділ.`)) void act('d' + row.id, () => siteCall('forum.sections.delete', { id: row.id }), 'Розділ видалено') }}>видалити</button>
            </li>
          ))}
          {!rows.length && <li className="px-3 py-6 text-center text-sm text-gray-400">Розділів ще немає</li>}
        </ul>
        <form className="flex gap-2" onSubmit={event => { event.preventDefault(); const value = name.trim(); if (value.length >= 3) void act('new', () => siteCall('forum.sections.upsert', { name: value }), 'Розділ створено').then(() => setName('')) }}>
          <input value={name} onChange={event => setName(event.target.value)} maxLength={80} placeholder="Назва нового розділу" className={input} aria-label="Назва нового розділу" />
          <Button type="submit" size="sm" loading={busy === 'new'} disabled={name.trim().length < 3}>Додати</Button>
        </form>
      </div>
    </Modal>
  )
}
