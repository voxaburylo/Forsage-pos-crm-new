import { useEffect, useLayoutEffect, useRef } from 'react'

const openDialogs: symbol[] = []

/** A dialog owns its close guard; the page behind it must never dismiss it. */
export function useDialogEscape(open: boolean, onClose: () => void, options: { disabled?: boolean } = {}) {
  const token = useRef(Symbol('dialog'))
  const latest = useRef({ onClose, disabled: options.disabled })
  useLayoutEffect(() => { latest.current = { onClose, disabled: options.disabled } }, [onClose, options.disabled])
  useEffect(() => {
    if (!open) return
    const key = token.current
    openDialogs.push(key)
    const handle = (event: KeyboardEvent) => {
      // Bubble phase deliberately respects a combobox/dropdown that consumes Esc.
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || openDialogs[openDialogs.length - 1] !== key) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!latest.current.disabled) latest.current.onClose()
    }
    window.addEventListener('keydown', handle)
    return () => {
      window.removeEventListener('keydown', handle)
      const index = openDialogs.indexOf(key)
      if (index !== -1) openDialogs.splice(index, 1)
    }
  }, [open])
}
