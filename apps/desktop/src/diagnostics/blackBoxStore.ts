import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Used in the writer worker, not the Electron UI/main thread.
export class BlackBoxStore {
  private segment = 0
  private file = ''
  private size = 0
  private day = ''
  private readonly marker: string
  constructor(private readonly dir: string, private readonly run: string,
    private readonly maxBytes = 1024 * 1024, private readonly maxFiles = 32,
    private readonly now: () => Date = () => new Date()) {
    mkdirSync(dir, { recursive: true })
    this.marker = path.join(dir, 'last-session.json')
  }
  start(): void {
    try {
      const previous = JSON.parse(readFileSync(this.marker, 'utf8'))
      if (previous.clean === false) this.write('previous-session-unclean', {
        previous_run: typeof previous.run === 'string' && /^[a-f0-9-]{36}$/.test(previous.run) ? previous.run : null,
        last_seen: typeof previous.at === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(previous.at) ? previous.at : null,
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.write('previous-session-unreadable', {})
    }
    this.checkpoint(false)
    this.write('session-start', {})
  }
  write(event: string, details: unknown, at = this.now().toISOString()): void {
    const line = JSON.stringify({ at, run: this.run, event, details }) + '\n'
    const bytes = Buffer.byteLength(line)
    if (bytes > this.maxBytes) return
    const day = this.now().toISOString().slice(0, 10)
    if (!this.file || this.day !== day || this.size + bytes > this.maxBytes) {
      this.day = day
      this.file = path.join(this.dir, `blackbox-${day}-${this.run}-${String(this.segment++).padStart(6, '0')}.jsonl`)
      this.size = 0
    }
    appendFileSync(this.file, line, 'utf8')
    this.size += bytes
    this.prune()
  }
  checkpoint(clean: boolean): void {
    const temporary = this.marker + '.tmp'
    writeFileSync(temporary, JSON.stringify({ run: this.run, at: this.now().toISOString(), clean }))
    renameSync(temporary, this.marker)
  }
  private prune(): void {
    const files = readdirSync(this.dir).filter(name => /^blackbox-\d{4}-\d{2}-\d{2}-[a-f0-9-]{36}-\d{6}\.jsonl$/.test(name))
      .map(name => ({ name, time: statSync(path.join(this.dir, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time || b.name.localeCompare(a.name))
    const cutoff = this.now().getTime() - 14 * 86400_000
    let kept = 1
    for (const file of files) {
      const target = path.join(this.dir, file.name)
      if (target === this.file) continue
      if (kept >= this.maxFiles || file.time < cutoff) unlinkSync(target)
      else kept++
    }
  }
}
