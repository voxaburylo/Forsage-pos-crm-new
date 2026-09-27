import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { BackupStatusSummary, type ShiftCopyStatus } from './BackupStatusSummary'
const copy: ShiftCopyStatus = { id: 'shift', closed_at: '2026-09-22T15:00:00Z', captured_at: '2026-09-22T15:01:00Z', export_directory: 'exports', local_ready: true, exports_ready: true, local_error: null, cloud_error: null, cloud_completed_at: null }
it('never calls a local-only copy externally confirmed', () => {
  const html = renderToStaticMarkup(<BackupStatusSummary backups={[]} shifts={[copy]}/>)
  expect(html).toContain('Підтвердженої зовнішньої копії немає')
  expect(html).toContain('ще не має підтвердженої зовнішньої копії')
  expect(html).toContain('Обидва файли готові')
})
it('keeps the latest pending shift distinct from an older confirmed copy', () => {
  const html = renderToStaticMarkup(<BackupStatusSummary backups={[]} shifts={[{ ...copy, local_ready: false, exports_ready: false }, { ...copy, id: 'old', captured_at: '2026-09-20T15:00:00Z', cloud_completed_at: '2026-09-21T10:00:00Z' }]}/>)
  expect(html).toContain('Дані станом на'); expect(html).toContain('20.09.2026')
  expect(html).toContain('ще не має підтвердженої зовнішньої копії')
  expect(html).toContain('Не готова або файли відсутні')
  expect(html).toContain('Файли не готові або недоступні')
})
it('does not assert that files exist when an old EXE cannot verify them', () => {
  const html = renderToStaticMarkup(<BackupStatusSummary backups={[]} shifts={[{ ...copy, local_ready: undefined, exports_ready: undefined }]}/>)
  expect(html).toContain('Стан файлів не перевірено')
  expect(html).not.toContain('Обидва файли готові')
})
