import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BlackBoxStore } from '../src/diagnostics/blackBoxStore'
import { safeDiagnosticDetails, safeDiagnosticEvent } from '../src/diagnostics/blackBoxData'

describe('private bounded local black box', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'forsage-blackbox-test-')) })
  afterEach(() => {
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-blackbox-test-')) rmSync(root, { recursive: true, force: true })
  })
  const events = () => readdirSync(root).filter(f => f.endsWith('.jsonl')).flatMap(f => readFileSync(path.join(root, f), 'utf8').trim().split('\n').map(line => JSON.parse(line)))
  it('records previous abnormal closure without rewriting business data', () => {
    const first = new BlackBoxStore(root, randomUUID()); first.start(); first.checkpoint(false)
    const second = new BlackBoxStore(root, randomUUID()); second.start()
    expect(events().filter(e => e.event === 'previous-session-unclean')).toHaveLength(1)
  })
  it('does not report an orderly shutdown as an accident', () => {
    const first = new BlackBoxStore(root, randomUUID()); first.start(); first.checkpoint(true)
    new BlackBoxStore(root, randomUUID()).start()
    expect(events().some(e => e.event === 'previous-session-unclean')).toBe(false)
  })
  it('records an unreadable session marker instead of inventing clean shutdown', () => {
    writeFileSync(path.join(root, 'last-session.json'), '{broken')
    new BlackBoxStore(root, randomUUID()).start()
    expect(events().some(e => e.event === 'previous-session-unreadable')).toBe(true)
  })
  it('rotates by bytes and enforces file count without deleting unrelated files', () => {
    writeFileSync(path.join(root, 'keep-me.txt'), 'unrelated')
    const store = new BlackBoxStore(root, randomUUID(), 500, 3); store.start()
    for (let i = 0; i < 40; i++) store.write('command-end', { sequence: i })
    const logs = readdirSync(root).filter(f => f.endsWith('.jsonl'))
    expect(logs.length).toBeLessThanOrEqual(3)
    expect(logs.every(f => statSync(path.join(root, f)).size <= 500)).toBe(true)
    expect(readFileSync(path.join(root, 'keep-me.txt'), 'utf8')).toBe('unrelated')
  })
  it('rotates on the UTC date boundary', () => {
    let now = new Date('2026-01-01T23:59:59Z')
    const store = new BlackBoxStore(root, randomUUID(), 10000, 32, () => now); store.start()
    now = new Date('2026-01-02T00:00:01Z'); store.write('health', {})
    expect(readdirSync(root).filter(f => f.endsWith('.jsonl')).length).toBe(2)
  })
  it('removes only old black-box segments, not other logs or backups', () => {
    const old = `blackbox-2020-01-01-${randomUUID()}-000000.jsonl`
    writeFileSync(path.join(root, old), '{}'); utimesSync(path.join(root, old), new Date(0), new Date(0))
    new BlackBoxStore(root, randomUUID()).start()
    expect(readdirSync(root)).not.toContain(old)
  })
  it('never serializes inputs, outputs, customer fields or raw error text', () => {
    const error = new Error('password=secret-token phone=+380501234567')
    error.stack = 'Error: secret-token\n at C:\\Users\\PrivateName\\app\\main.js:45:8'
    const data = safeDiagnosticDetails({ channel: 'desktop:auth:login', role: 'owner',
      args: ['private-user', 'secret-token'], result: { phone: '+380501234567' }, error,
      url: 'https://example.test/?token=secret-token', duration_ms: 42 })
    const text = JSON.stringify(data)
    for (const secret of ['secret-token', '+380501234567', 'private-user', 'PrivateName', 'example.test']) expect(text).not.toContain(secret)
    expect(data).toMatchObject({ channel: 'desktop:auth:login', duration_ms: 42,
      error: { error_type: 'Error', frames: ['main.js:45:8'] } })
  })
  it('keeps a stable error fingerprint for comparison', () => {
    expect(safeDiagnosticDetails('network failed')).toEqual(safeDiagnosticDetails('network failed'))
    expect(safeDiagnosticDetails('network failed')).not.toEqual(safeDiagnosticDetails('SQL failed'))
  })
  it('rejects invalid names and unsafe nested metadata', () => {
    expect(safeDiagnosticEvent('password: secret')).toBe('unknown-event')
    expect(safeDiagnosticDetails({ channel: 'a\nsecret', rss_mb: Infinity, customer: { name: 'private' } })).toEqual({})
  })
})
