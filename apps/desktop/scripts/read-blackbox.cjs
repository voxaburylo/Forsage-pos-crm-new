// Read-only daily diagnostic summary; never opens the business database.
const fs = require('node:fs')
const path = require('node:path')
const dir = process.argv[2]
const day = process.argv[3]
if (!dir || !/^\d{4}-\d{2}-\d{2}$/.test(day || '')) {
  console.error('Usage: node read-blackbox.cjs ABSOLUTE_LOG_DIRECTORY YYYY-MM-DD (local calendar day)')
  process.exit(1)
}
const counts = Object.create(null), errors = Object.create(null), slow = [], open = new Map()
let malformed = 0
for (const file of fs.readdirSync(dir).filter(f => /^blackbox-.*\.jsonl$/.test(f)).sort()) {
  const full = path.join(dir, file)
  if (fs.statSync(full).size > 2 * 1024 * 1024) { malformed++; continue }
  for (const line of fs.readFileSync(full, 'utf8').split('\n').filter(Boolean)) {
    let row
    try { row = JSON.parse(line) } catch { malformed++; continue }
    const date = new Date(row.at)
    if (!Number.isFinite(date.getTime())) { malformed++; continue }
    const local = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
    if (local !== day) continue
    counts[row.event] = (counts[row.event] || 0) + 1
    const d = row.details || {}, key = `${row.run}:${d.sequence}`
    if (row.event === 'command-start') open.set(key, { at: row.at, channel: d.channel })
    if (row.event === 'command-end') {
      open.delete(key)
      if (d.duration_ms >= 1000) slow.push({ at: row.at, channel: d.channel, duration_ms: d.duration_ms, status: d.status })
    }
    const error = d.error || d
    if (error.fingerprint) {
      const id = `${row.event}:${d.channel || ''}:${error.fingerprint}`
      errors[id] = (errors[id] || 0) + 1
    }
  }
}
console.log(JSON.stringify({ day, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  events: counts, errors, slowest: slow.sort((a,b)=>b.duration_ms-a.duration_ms).slice(0,30),
  commands_without_end_in_retained_day: [...open.values()].slice(-30), malformed,
  note: 'Missing end records can mean a crash, log rotation, rate limiting or crossing midnight; they are not proof of a failed business operation.',
}, null, 2))
