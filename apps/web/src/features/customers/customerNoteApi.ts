import { api } from '@/lib/api'
import type { CustomerNote, NoteColor } from '@/types/customerNote'

const base = (customerId: string) => '/api/v1/customers/' + customerId + '/notes'

export const customerNoteApi = {
  list: (customerId: string) =>
    api.get<{ data: CustomerNote[] }>(base(customerId)),

  create: (customerId: string, body: { text: string; is_pinned?: boolean; color?: NoteColor }) =>
    api.post<{ data: CustomerNote }>(base(customerId), body),

  update: (customerId: string, noteId: string, body: { text?: string; is_pinned?: boolean; color?: NoteColor }) =>
    api.patch<{ data: CustomerNote }>(base(customerId) + '/' + noteId, body),

  delete: (customerId: string, noteId: string) =>
    api.delete<void>(base(customerId) + '/' + noteId),
}
