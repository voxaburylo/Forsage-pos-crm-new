export type NoteColor = 'yellow' | 'red' | 'green' | 'blue'

export const NOTE_COLOR_CLASS: Record<NoteColor, string> = {
  yellow: 'bg-yellow-50 border-yellow-300 text-yellow-900',
  red:    'bg-red-50 border-red-300 text-red-900',
  green:  'bg-green-50 border-green-300 text-green-900',
  blue:   'bg-blue-50 border-blue-300 text-blue-900',
}

export const NOTE_COLOR_LABEL: Record<NoteColor, string> = {
  yellow: 'Жовта',
  red:    'Червона',
  green:  'Зелена',
  blue:   'Синя',
}

export interface CustomerNote {
  id:          string
  customer_id: string
  text:        string
  is_pinned:   boolean
  color:       NoteColor
  created_by:  string
  created_at:  string
  updated_at:  string
}
