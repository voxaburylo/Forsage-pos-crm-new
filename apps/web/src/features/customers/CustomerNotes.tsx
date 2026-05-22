import { useState, useEffect, useCallback } from 'react'
import { Pin, Trash2, Plus, X, Check } from 'lucide-react'
import { customerNoteApi } from './customerNoteApi'
import { NOTE_COLOR_CLASS, NOTE_COLOR_LABEL } from '@/types/customerNote'
import type { CustomerNote, NoteColor } from '@/types/customerNote'
import { toast } from '@/components/ui/Toast'
import { formatDate } from '@/lib/utils'

const COLORS: NoteColor[] = ['yellow', 'red', 'green', 'blue']

interface Props {
  customerId: string
}

export default function CustomerNotes({ customerId }: Props) {
  const [notes, setNotes]     = useState<CustomerNote[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding]   = useState(false)
  const [text, setText]       = useState('')
  const [color, setColor]     = useState<NoteColor>('yellow')
  const [pinned, setPinned]   = useState(false)
  const [saving, setSaving]   = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await customerNoteApi.list(customerId)
      setNotes(res.data)
    } catch {
      toast.error('Помилка завантаження нотаток')
    } finally {
      setLoading(false)
    }
  }, [customerId])

  useEffect(() => { load() }, [load])

  async function handleAdd() {
    if (!text.trim()) return
    setSaving(true)
    try {
      await customerNoteApi.create(customerId, { text: text.trim(), is_pinned: pinned, color })
      setText(''); setColor('yellow'); setPinned(false); setAdding(false)
      load()
    } catch {
      toast.error('Помилка збереження нотатки')
    } finally {
      setSaving(false)
    }
  }

  async function handleTogglePin(note: CustomerNote) {
    try {
      await customerNoteApi.update(customerId, note.id, { is_pinned: !note.is_pinned })
      load()
    } catch { toast.error('Помилка оновлення') }
  }

  async function handleDelete(noteId: string) {
    if (!confirm('Видалити нотатку?')) return
    try {
      await customerNoteApi.delete(customerId, noteId)
      load()
    } catch { toast.error('Помилка видалення') }
  }

  if (loading) return <p className="text-gray-400 text-sm">Завантаження...</p>

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-800">
          Нотатки {notes.length > 0 && '(' + notes.length + ')'}
        </h3>
        {!adding && (
          <button onClick={() => setAdding(true)}
            className="flex items-center gap-1 text-xs text-yellow-600 hover:text-yellow-700 font-medium">
            <Plus size={14} /> Додати
          </button>
        )}
      </div>

      {adding && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 mb-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Текст нотатки..."
            rows={3}
            autoFocus
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-yellow-400 resize-none mb-2"
          />
          <div className="flex items-center gap-3">
            <div className="flex gap-1">
              {COLORS.map((c) => (
                <button key={c} onClick={() => setColor(c)}
                  className={
                    'w-6 h-6 rounded-full border-2 transition-all ' +
                    (c === 'yellow' ? 'bg-yellow-400 ' : '') +
                    (c === 'red'    ? 'bg-red-400 '    : '') +
                    (c === 'green'  ? 'bg-green-400 '  : '') +
                    (c === 'blue'   ? 'bg-blue-400 '   : '') +
                    (color === c ? 'border-gray-700 scale-110' : 'border-transparent')
                  }
                  title={NOTE_COLOR_LABEL[c]}
                />
              ))}
            </div>
            <label className="flex items-center gap-1 text-xs text-gray-600 cursor-pointer">
              <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)}
                className="rounded" />
              Закріпити
            </label>
            <div className="ml-auto flex gap-2">
              <button onClick={() => { setAdding(false); setText('') }}
                className="text-gray-400 hover:text-gray-600 p-1"><X size={16} /></button>
              <button onClick={handleAdd} disabled={saving || !text.trim()}
                className="bg-yellow-400 hover:bg-yellow-500 text-black text-xs font-semibold px-3 py-1 rounded-lg disabled:opacity-50 flex items-center gap-1">
                <Check size={14} /> Зберегти
              </button>
            </div>
          </div>
        </div>
      )}

      {notes.length === 0 && !adding && (
        <p className="text-gray-400 text-sm italic">Нотаток немає</p>
      )}

      <div className="space-y-2">
        {notes.map((note) => (
          <div key={note.id}
            className={'border rounded-xl px-3 py-2 ' + NOTE_COLOR_CLASS[note.color]}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm flex-1 whitespace-pre-wrap">{note.text}</p>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => handleTogglePin(note)}
                  className={'p-1 rounded transition-colors ' + (note.is_pinned ? 'opacity-100' : 'opacity-30 hover:opacity-60')}
                  title={note.is_pinned ? 'Відкріпити' : 'Закріпити'}>
                  <Pin size={14} />
                </button>
                <button onClick={() => handleDelete(note.id)}
                  className="p-1 rounded opacity-30 hover:opacity-70 transition-colors">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            <p className="text-xs opacity-60 mt-1">{formatDate(note.created_at)}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
