import { useEffect, useRef, useState } from 'react'
import { desktopBridge } from '@/lib/desktopBridge'
import type { LineItem } from './invoiceFormModel'
import { applyInvoiceMatch, invoiceMatchInput, invoiceMatchProblems } from './aiInvoiceMatching'

export function useAiInvoiceMatching(items: LineItem[], update: (fn: (items: LineItem[]) => LineItem[]) => void) {
  const latest = useRef({ items, update })
  useEffect(() => { latest.current = { items, update } }, [items, update])
  const fingerprint = JSON.stringify(items.filter(item => item.ai_review).map(item => [item.client_key, invoiceMatchInput(item)]))
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState({ fingerprint: '', attempt: 0, error: '' })
  const retryQueued = useRef(false)
  useEffect(() => {
    retryQueued.current = false
    if (fingerprint === '[]') return
    let cancelled = false
    let deadline: ReturnType<typeof setTimeout> | undefined
    const finish = (error: string) => {
      if (cancelled) return
      if (deadline) clearTimeout(deadline)
      setResult({ fingerprint, attempt, error })
    }
    const timer = setTimeout(() => {
      const preview = desktopBridge()?.supply?.previewInvoiceFromAi
      if (!preview) { finish('Не вдалося перевірити товари. Перезапустіть оновлену локальну програму.'); return }
      const snapshot = latest.current.items.filter(item => item.ai_review)
      deadline = setTimeout(() => {
        finish('Перевірка товарів не відповіла. Повторіть перевірку; введені дані збережено.')
        // An IPC response may still arrive; it must not overwrite an explicit retry.
        cancelled = true
      }, 30_000)
      void Promise.resolve().then(() => preview({ rows: snapshot.map(invoiceMatchInput) })).then(reviews => {
        if (cancelled) return
        if (reviews.length !== snapshot.length) throw new Error('Перевірено не всі товари')
        const matches = new Map(snapshot.map((item,i) => [item.client_key, reviews[i]]))
        latest.current.update(current => current.map(item => matches.has(item.client_key) ? applyInvoiceMatch(item, matches.get(item.client_key)!) : item))
        finish('')
      }).catch(cause => finish(cause instanceof Error ? cause.message : 'Не вдалося перевірити товари'))
    }, 200)
    return () => { cancelled = true; clearTimeout(timer); if (deadline) clearTimeout(deadline) }
  }, [fingerprint, attempt])
  const settled = result.fingerprint === fingerprint && result.attempt === attempt
  const pending = fingerprint !== '[]' && !settled
  const problemCount = items.filter(item => invoiceMatchProblems(item).length > 0).length
  const activeError = fingerprint !== '[]' && settled ? result.error : ''
  function retry() {
    if (!activeError || retryQueued.current) return
    // Lock synchronously: two clicks before React renders still enqueue one request.
    retryQueued.current = true
    setAttempt(value => value + 1)
  }
  return { pending, error: activeError, problemCount, retry, ready: !pending && !activeError && !problemCount }
}
