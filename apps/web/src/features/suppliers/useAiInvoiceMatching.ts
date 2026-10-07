import { useEffect, useRef, useState } from 'react'
import { desktopBridge } from '@/lib/desktopBridge'
import type { LineItem } from './invoiceFormModel'
import { applyInvoiceMatch, invoiceMatchInput, invoiceMatchProblems } from './aiInvoiceMatching'

export function useAiInvoiceMatching(items: LineItem[], update: (fn: (items: LineItem[]) => LineItem[]) => void) {
  const latest = useRef({ items, update })
  useEffect(() => { latest.current = { items, update } }, [items, update])
  const fingerprint = JSON.stringify(items.filter(item => item.ai_review).map(item => [item.client_key, invoiceMatchInput(item)]))
  const [checked, setChecked] = useState(''), [error, setError] = useState('')
  useEffect(() => {
    if (fingerprint === '[]') return
    let cancelled = false
    const timer = setTimeout(() => {
      const preview = desktopBridge()?.supply?.previewInvoiceFromAi
      if (!preview) { setError('Не вдалося перевірити товари. Перезапустіть оновлену локальну програму.'); return }
      const snapshot = latest.current.items.filter(item => item.ai_review)
      void preview({ rows: snapshot.map(invoiceMatchInput) }).then(reviews => {
        if (cancelled) return
        if (reviews.length !== snapshot.length) throw new Error('Перевірено не всі товари')
        const matches = new Map(snapshot.map((item,i) => [item.client_key, reviews[i]]))
        latest.current.update(current => current.map(item => matches.has(item.client_key) ? applyInvoiceMatch(item, matches.get(item.client_key)!) : item))
        setChecked(fingerprint); setError('')
      }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Не вдалося перевірити товари') })
    }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [fingerprint])
  const pending = fingerprint !== '[]' && checked !== fingerprint
  const problemCount = items.filter(item => invoiceMatchProblems(item).length > 0).length
  const activeError = fingerprint === '[]' ? '' : error
  return { pending, error: activeError, problemCount, ready: !pending && !activeError && !problemCount }
}
