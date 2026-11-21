import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card } from '@/components/ui'

/** Блок налаштувань із посиланнями на окремі сторінки (вони лишаються за своїми адресами). */
export function SettingsLinksCard({ icon, title, note, links, children }: {
  icon: ReactNode
  title: string
  note?: string
  links: Array<{ to: string; label: string }>
  children?: ReactNode
}) {
  const navigate = useNavigate()
  return (
    <Card className="mt-6 space-y-3">
      <div className="flex items-center gap-2 pb-3 border-b border-gray-100">{icon}<h3 className="text-sm font-semibold text-gray-800">{title}</h3></div>
      {note && <p className="text-xs text-gray-500">{note}</p>}
      <div className="flex flex-wrap gap-2">
        {links.map(link => (
          <button key={link.to} type="button" onClick={() => navigate(link.to)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
            {link.label}
          </button>
        ))}
      </div>
      {children}
    </Card>
  )
}
