import { useEffect, useRef, useState, type ReactNode } from 'react'

/** Keep off-screen catalogue pages out of the DOM without losing their height. */
export function CatalogChunk({ table = false, children }: { table?: boolean; children: () => ReactNode }) {
  const node = useRef<HTMLElement | null>(null)
  const [visible, setVisible] = useState(true)
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const element = node.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true)
      } else if (!element.contains(document.activeElement)) {
        const measured = element.getBoundingClientRect().height
        if (measured > 0) {
          setHeight(measured)
          setVisible(false)
        }
      }
    }, { root: document.getElementById('app-main-scroll'), rootMargin: '1600px 0px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return table
    ? <tbody ref={(element) => { node.current = element }} className="divide-y divide-gray-50">
        {visible ? children() : <tr aria-hidden="true"><td colSpan={11} style={{ height, padding: 0, border: 0 }} /></tr>}
      </tbody>
    : <div ref={(element) => { node.current = element }} className="divide-y divide-gray-100"
        style={visible ? undefined : { height }} aria-hidden={!visible || undefined}>
        {visible ? children() : null}
      </div>
}

export function catalogChunks<T>(items: T[], size = 25): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

export function useDesktopCatalogLayout() {
  const [desktop, setDesktop] = useState(() => window.matchMedia('(min-width: 768px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(min-width: 768px)')
    const update = () => setDesktop(query.matches)
    query.addEventListener('change', update)
    update()
    return () => query.removeEventListener('change', update)
  }, [])
  return desktop
}
